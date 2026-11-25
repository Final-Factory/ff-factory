#!/usr/bin/env python3
"""ff-landlock: run a command that may write only beneath the given folders (Linux Landlock, no root, no namespaces).

Reads and execs stay free everywhere; every write-type access (create, write, truncate, remove, rename, link, mknod)
is refused outside the --rw paths. Landlock rules only add rights, so a folder to keep read-only inside a writable
tree (the daemon's folder inside ffw) is made by granting each sibling instead: --rw-children <dir> --except <name>.
The restriction is inherited by every child process and cannot be lifted.

  ff-landlock.py --rw /dev --rw-children ~/ffw --except daemon --except repo --except secrets -- cmd args...

Reads (w5546): --no-read PATH closes PATH to reads (a folder: everything below it). Landlock only grants, so once any
--no-read is given the program handles READ_FILE and READ_DIR and grants them on everything else: walking from / down
each closed path's parents, every sibling off those chains gets read, and each parent on a chain gets READ_DIR only
(names may be listed, as the guard allows; a file there is read only through a sibling grant). --read PATH gives one
path inside a closed folder back. Symbolic links are not followed (the target is granted where it lives), so a link
cannot open a closed folder. A file made directly in a chain folder after the start (a new file in $HOME) is not
readable by this run; one made below a granted sibling is.

  ff-landlock.py ... --no-read <root>/secrets --no-read <root>/root.json --read <root>/<closed>/logs -- cmd
"""
import ctypes, os, struct, sys

SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446  # x86_64 and aarch64 share these numbers
PR_SET_NO_NEW_PRIVS = 38
WRITE_FILE, REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR, MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = (
    1 << 1, 1 << 4, 1 << 5, 1 << 6, 1 << 7, 1 << 8, 1 << 9, 1 << 10, 1 << 11, 1 << 12)
EXECUTE, READ_FILE, READ_DIR = 1 << 0, 1 << 2, 1 << 3
REFER, TRUNCATE = 1 << 13, 1 << 14
FILE_ONLY = WRITE_FILE | TRUNCATE

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]




def is_under(p, d):
    return p == d or p.startswith(d.rstrip('/') + '/')


def read_grants(no_read, back):
    """(path, rights) pairs that give read everywhere except below each no_read path, then each back path (w5546)."""
    closed = [os.path.realpath(p) for p in no_read]
    chains = set()
    for c in closed:
        a = os.path.dirname(c)
        while True:
            chains.add(a)
            if a == '/':
                break
            a = os.path.dirname(a)
    out = [(a, READ_DIR) for a in sorted(chains)]
    for a in sorted(chains):
        try:
            names = sorted(os.listdir(a))
        except OSError:
            continue
        for n in names:
            full = os.path.join(a, n)
            if full in chains or any(is_under(full, c) for c in closed) or os.path.islink(full):
                continue
            out.append((full, READ_FILE | READ_DIR | EXECUTE))
    for b in back:
        out.append((os.path.realpath(b), READ_FILE | READ_DIR | EXECUTE))
    return out


def add_rule(rfd, fd, allowed, p):
    rule = ctypes.create_string_buffer(struct.pack('=Qi', allowed, fd), 12)  # struct landlock_path_beneath_attr, packed
    if libc.syscall(SYS_ADD, rfd, 1, rule, 0) != 0:
        die(f'add_rule {p} failed (errno {ctypes.get_errno()})')
    os.close(fd)


def die(msg):
    sys.stderr.write(f'ff-landlock: {msg}\n')
    sys.exit(125)


def main(argv):
    if '--' not in argv:
        die('usage: ff-landlock.py [--rw PATH]... [--rw-children DIR [--except NAME]...]... -- CMD [ARGS]')
    i = argv.index('--')
    opts, cmd = argv[:i], argv[i + 1:]
    if not cmd:
        die('no command')
    rw, socks, children, cur, log, no_read, back = [], [], [], None, False, [], []
    it = iter(opts)
    for a in it:
        if a == '--rw':
            rw.append(next(it))
        elif a == '--rw-children':
            cur = [next(it), set()]
            children.append(cur)
        elif a == '--sock':
            socks.append(next(it))  # only make and remove sockets there (Claude Code's $XDG_RUNTIME_DIR/cc-socks)
        elif a == '--no-read':
            no_read.append(next(it))
        elif a == '--read':
            back.append(next(it))
        elif a == '--log':
            log = True  # audit-log refused writes of every program it starts (ABI 7+): journalctl -k | grep landlock
        elif a == '--except' and cur:
            cur[1].add(next(it))
        else:
            die(f'unknown option {a}')
    for d, skip in children:
        for name in sorted(os.listdir(d)):
            if name not in skip:
                rw.append(os.path.join(d, name))

    abi = libc.syscall(SYS_CREATE, None, 0, 1)  # LANDLOCK_CREATE_RULESET_VERSION
    if abi < 1:
        die(f'Landlock unavailable (errno {ctypes.get_errno()})')
    handled = WRITE_FILE | REMOVE_DIR | REMOVE_FILE | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM
    if abi >= 2:
        handled |= REFER
    if abi >= 3:
        handled |= TRUNCATE
    write_rights = handled
    grants = []
    if no_read:
        handled |= READ_FILE | READ_DIR | EXECUTE
        grants = read_grants(no_read, back)
    attr = RulesetAttr(handled)
    rfd = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if rfd < 0:
        die(f'create_ruleset failed (errno {ctypes.get_errno()})')
    for p, sock in [(p, False) for p in rw] + [(p, True) for p in socks]:
        try:
            fd = os.open(p, os.O_PATH | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        allowed = (MAKE_SOCK | REMOVE_FILE) if sock else write_rights if os.path.isdir(p) else write_rights & FILE_ONLY
        add_rule(rfd, fd, allowed, p)
    for p, rights in grants:
        try:
            fd = os.open(p, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError:
            continue  # gone: nothing to grant
        add_rule(rfd, fd, rights if os.path.isdir(p) else rights & (READ_FILE | EXECUTE), p)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die('no_new_privs failed')
    if libc.syscall(SYS_RESTRICT, rfd, 2 if log and abi >= 7 else 0) != 0:  # LANDLOCK_RESTRICT_SELF_LOG_NEW_EXEC_ON
        die(f'restrict_self failed (errno {ctypes.get_errno()})')
    os.close(rfd)
    os.environ['FF_LANDLOCK_ABI'] = str(abi)
    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        die(f'exec {cmd[0]}: {e}')


if __name__ == '__main__':
    main(sys.argv[1:])
