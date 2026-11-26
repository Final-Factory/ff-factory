//! FF Factory (w6062): the ffu slot guard's reference-transaction hook as a native program, the same check as
//! `../reference-transaction` and `../slot-guard.sh` (w6038), line for line. Git runs this hook at every phase of every
//! ref transaction, 7 times for one `git commit` (preparing, prepared, committed; preparing, aborted, prepared,
//! committed), and on Windows each start of Git Bash's sh cost about 30 ms there (LothDesktop, measured 2026-11-26: the
//! shell hooks added about 210 ms per commit, a native hook that does nothing about 100 ms). `ffu-slot take` builds it
//! with rustc into `<install>/ffu-sandboxes/hooks/<hash>/` on Windows (machine/ffuSlots.ts ensureNativeSlotHooks) and
//! keeps the shell hooks when it cannot. std only: built with `rustc` alone, no cargo, no crates.
//!
//! Change this file and slot-guard.sh together: server/ffuSlotGuard.test.ts runs every refusal against both.

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, BufRead};
use std::path::Path;
use std::process::exit;

fn main() {
    // Only the `prepared` phase can still stop the update; every other phase exits at once.
    if env::args_os().nth(1).as_deref() != Some(OsStr::new("prepared")) {
        exit(0);
    }
    let session = env::var("FF_SESSION_ID").unwrap_or_default();
    if session.is_empty() {
        exit(0);
    }
    let Ok(cwd) = env::current_dir() else { exit(0) };
    let pwd = slashed(&cwd);
    if !in_slot(&pwd) {
        exit(0);
    }
    // `<old> <new> <ref>` per line: the last ref the transaction really moves, as reference-transaction picks it.
    let mut write = String::new();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let mut f = line.split_whitespace();
        let (Some(old), Some(new), Some(r)) = (f.next(), f.next(), f.next()) else { continue };
        if new.starts_with("ref:") || old == new || r.starts_with("refs/remotes/") {
            continue;
        }
        if r == "HEAD" || r.starts_with("refs/") {
            write = r.to_string();
        }
    }
    if write.is_empty() {
        exit(0);
    }
    if let Some(msg) = refusal(&format!("git updating {write}"), &pwd, &session) {
        eprintln!("{msg}");
        exit(1);
    }
}

/// The folder as sh's $PWD shows it in a Windows hook: forward slashes, no `\\?\` prefix.
fn slashed(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

/// sh's `case "$PWD" in */ffu-sandboxes/slot*/ffu)`.
fn in_slot(pwd: &str) -> bool {
    pwd.strip_suffix("/ffu").is_some_and(|d| d.contains("/ffu-sandboxes/slot"))
}

/// sh's `read -r a b <file`: the first line, or none.
fn first_line(p: &Path) -> Option<String> {
    let text = fs::read_to_string(p).ok()?;
    Some(text.lines().next().unwrap_or("").trim_end_matches('\r').to_string())
}

/// slot-guard.sh's ffu_slot_guard: the refusal, or None.
fn refusal(what: &str, pwd: &str, session: &str) -> Option<String> {
    let dir = pwd.strip_suffix("/ffu")?;
    let holder_file = Path::new(dir).join("holder");
    if !holder_file.is_file() {
        return None;
    }
    let slot = dir.rsplit('/').next().unwrap_or(dir);
    let (mut holder, mut branch) = (String::new(), String::new());
    for line in fs::read_to_string(&holder_file).unwrap_or_default().lines() {
        let line = line.trim_matches(|c| c == ' ' || c == '\t' || c == '\r');
        let (k, v) = match line.find([' ', '\t']) {
            Some(i) => (&line[..i], line[i..].trim_matches(|c| c == ' ' || c == '\t')),
            None => (line, ""),
        };
        match k {
            "holder" => holder = v.to_string(),
            "branch" => branch = v.to_string(),
            _ => {}
        }
    }
    let on = if branch.is_empty() { "origin/main, detached" } else { &branch };
    let fix = "Take your own slot and work there: eval \"$(ffu-slot take --branch <your branch>)\" (ffu-slot where --branch <b> names the one you hold). A merge stopped here leaves its files merged: git merge --abort puts them back (w6038).";
    if holder != session {
        return Some(if holder.is_empty() {
            format!("ffu-slot: refused: {what} in ffu slot {slot} ({pwd}), which no session holds (released; last on branch {on}); you are session {session}. {fix}")
        } else {
            format!("ffu-slot: refused: {what} in ffu slot {slot} ({pwd}), which session {holder} holds on branch {on}; you are session {session}. That is another worker's checkout. {fix}")
        });
    }
    if branch.is_empty() {
        return None;
    }
    // The checkout's branch, from its HEAD file (a worktree's .git file names its git folder).
    let cwd = Path::new(pwd);
    let dot_git = cwd.join(".git");
    let git_dir = if dot_git.is_file() {
        let line = first_line(&dot_git).unwrap_or_default();
        cwd.join(line.strip_prefix("gitdir: ").unwrap_or(&line))
    } else {
        dot_git
    };
    let cur = first_line(&git_dir.join("HEAD"))
        .and_then(|l| l.strip_prefix("ref: refs/heads/").map(str::to_string))
        .unwrap_or_default();
    // Detached (a rebase, or a branch another slot has checked out: push with HEAD:<branch>) is the recorded branch's own work.
    if !cur.is_empty() && cur != branch {
        return Some(format!("ffu-slot: refused: {what} on branch {cur} in ffu slot {slot} ({pwd}): your session {session} holds this slot for branch {branch}, and ffu-slot recorded no other. Go back with git switch {branch}, or take a slot for {cur}: eval \"$(ffu-slot take --branch {cur})\" (w6038)."));
    }
    None
}
