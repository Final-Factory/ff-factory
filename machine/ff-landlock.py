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

--create PATH (w5561): beneath PATH, only make regular files and sockets and remove files. No write, truncate, folder,
link, FIFO or device: the person's own files there cannot be changed, only removed or renamed within a folder. Unity's
/tmp sockets and its shader compiler's lock (opened O_RDONLY|O_CREAT, then flock) need no more.

Signals (w5562, ABI 6+): the command and its children may signal only processes of their own Landlock domain (or one
nested in it), so a careless `pkill -f` cannot end the daemon, a Unity editor, another worker or the desktop. Signals
sent to them from outside are not affected.

--deny-unix PATH (w5562, ABI 9+): connect() to pathname UNIX sockets at or beneath PATH is refused (EACCES): the
systemd user bus and manager sockets, through which `systemd-run --user` starts a job outside this lock. Connecting
anywhere else stays free, granted per sibling as --except does, so a socket an outside server makes later directly in
one of PATH's parent folders is refused too; sockets this command's own processes make stay reachable. On an older
kernel the option is a no-op and says so on stderr.
"""
import ctypes, os, struct, sys

SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446  # x86_64 and aarch64 share these numbers
PR_SET_NO_NEW_PRIVS = 38
WRITE_FILE, REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR, MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = (
    1 << 1, 1 << 4, 1 << 5, 1 << 6, 1 << 7, 1 << 8, 1 << 9, 1 << 10, 1 << 11, 1 << 12)
EXECUTE, READ_FILE, READ_DIR = 1 << 0, 1 << 2, 1 << 3
REFER, TRUNCATE, RESOLVE_UNIX = 1 << 13, 1 << 14, 1 << 16
SCOPE_SIGNAL = 1 << 1
FILE_ONLY = WRITE_FILE | TRUNCATE

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]


class RulesetAttrV6(ctypes.Structure):  # ABI 6 added handled_access_net (ABI 4) and scoped to the attr the kernel reads
    _fields_ = [('handled_access_fs', ctypes.c_uint64), ('handled_access_net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]


def unix_grants(denied):
    """Every path to grant RESOLVE_UNIX on so that all but the denied paths stay connectable: each sibling of a
    denied path and of each of its parents, down from /. Landlock rules only add rights, as with --except."""
    denied = [os.path.normpath(os.path.abspath(d)) for d in denied]
    parents = set()
    for d in denied:
        p = os.path.dirname(d)
        while True:
            parents.add(p)
            if p == '/':
                break
            p = os.path.dirname(p)
    out = []
    for p in sorted(parents):
        try:
            names = sorted(os.listdir(p))
        except OSError:
            continue
        for n in names:
            c = os.path.join(p, n)
            if c not in parents and c not in denied:
                out.append(c)
    return out




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
        die('usage: ff-landlock.py [--rw PATH]... [--rw-children DIR [--except NAME]...]... [--sock DIR]... [--create DIR]... -- CMD [ARGS]')
    i = argv.index('--')
    opts, cmd = argv[:i], argv[i + 1:]
    if not cmd:
        die('no command')
    rw, socks, creates, children, cur, log, deny_unix, no_read, back = [], [], [], [], None, False, [], [], []
    it = iter(opts)
    for a in it:
        if a == '--rw':
            rw.append(next(it))
        elif a == '--rw-children':
            cur = [next(it), set()]
            children.append(cur)
        elif a == '--create':
            creates.append(next(it))
        elif a == '--sock':
            socks.append(next(it))  # only make and remove sockets there (Claude Code's $XDG_RUNTIME_DIR/cc-socks)
        elif a == '--no-read':
            no_read.append(next(it))
        elif a == '--read':
            back.append(next(it))
        elif a == '--deny-unix':
            deny_unix.append(next(it))
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
    unix = []
    if deny_unix and abi >= 9:
        handled |= RESOLVE_UNIX
        unix = unix_grants(deny_unix)
    elif deny_unix:
        sys.stderr.write(f'ff-landlock: --deny-unix needs Landlock ABI 9 (Linux 7.1); this kernel has ABI {abi}, so UNIX sockets stay reachable\n')
    write_rights = handled
    grants = []
    if no_read:
        handled |= READ_FILE | READ_DIR | EXECUTE
        grants = read_grants(no_read, back)
    attr = RulesetAttrV6(handled, 0, SCOPE_SIGNAL) if abi >= 6 else RulesetAttr(handled)
    rfd = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if rfd < 0:
        die(f'create_ruleset failed (errno {ctypes.get_errno()})')
    for p, kind in [(p, 'rw') for p in rw] + [(p, 'sock') for p in socks] + [(p, 'create') for p in creates] + [(p, 'unix') for p in unix]:
        try:
            fd = os.open(p, os.O_PATH | os.O_CLOEXEC)
        except (FileNotFoundError, PermissionError):
            continue
        if kind == 'unix':
            allowed = RESOLVE_UNIX
        elif kind == 'sock':
            allowed = MAKE_SOCK | REMOVE_FILE
        elif kind == 'create':
            allowed = MAKE_SOCK | MAKE_REG | REMOVE_FILE
        else:
            allowed = write_rights if os.path.isdir(p) else write_rights & (FILE_ONLY | RESOLVE_UNIX)
        add_rule(rfd, fd, allowed, f'{p} ({kind})')
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
