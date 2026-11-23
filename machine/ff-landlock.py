#!/usr/bin/env python3
"""ff-landlock: run a command that may write only beneath the given folders (Linux Landlock, no root, no namespaces).

Reads and execs stay free everywhere; every write-type access (create, write, truncate, remove, rename, link, mknod)
is refused outside the --rw paths. Landlock rules only add rights, so a folder to keep read-only inside a writable
tree (the daemon's folder inside ffw) is made by granting each sibling instead: --rw-children <dir> --except <name>.
The restriction is inherited by every child process and cannot be lifted.

  ff-landlock.py --rw /dev --rw-children ~/ffw --except daemon --except repo --except secrets -- cmd args...
"""
import ctypes, os, struct, sys

SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446  # x86_64 and aarch64 share these numbers
PR_SET_NO_NEW_PRIVS = 38
WRITE_FILE, REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR, MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = (
    1 << 1, 1 << 4, 1 << 5, 1 << 6, 1 << 7, 1 << 8, 1 << 9, 1 << 10, 1 << 11, 1 << 12)
REFER, TRUNCATE = 1 << 13, 1 << 14
FILE_ONLY = WRITE_FILE | TRUNCATE

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]




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
    rw, socks, children, cur, log = [], [], [], None, False
    it = iter(opts)
    for a in it:
        if a == '--rw':
            rw.append(next(it))
        elif a == '--rw-children':
            cur = [next(it), set()]
            children.append(cur)
        elif a == '--sock':
            socks.append(next(it))  # only make and remove sockets there (Claude Code's $XDG_RUNTIME_DIR/cc-socks)
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
    attr = RulesetAttr(handled)
    rfd = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if rfd < 0:
        die(f'create_ruleset failed (errno {ctypes.get_errno()})')
    for p, sock in [(p, False) for p in rw] + [(p, True) for p in socks]:
        try:
            fd = os.open(p, os.O_PATH | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        allowed = (MAKE_SOCK | REMOVE_FILE) if sock else handled if os.path.isdir(p) else handled & FILE_ONLY
        rule = ctypes.create_string_buffer(struct.pack('=Qi', allowed, fd), 12)  # struct landlock_path_beneath_attr, packed
        if libc.syscall(SYS_ADD, rfd, 1, rule, 0) != 0:
            die(f'add_rule {p} failed (errno {ctypes.get_errno()})')
        os.close(fd)
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
