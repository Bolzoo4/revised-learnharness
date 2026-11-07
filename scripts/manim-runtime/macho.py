#!/usr/bin/env python3
"""Mach-O helper for the Manim runtime (build and verify).

Usage:
  macho.py bundle ROOT   copy every non-system dependency into ROOT/lib, rewrite
                         references to @loader_path, drop absolute LC_RPATHs,
                         ad-hoc re-sign each changed file (dylibs first).
  macho.py check ROOT    fail on any reference that leaves ROOT (other than
                         /usr/lib and /System), any unresolved @loader_path or
                         @rpath, and any Mach-O that fails `codesign --verify`.
  macho.py dump ROOT     print `otool -L` for every Mach-O (for grep in verify.sh).
"""
import os
import shutil
import subprocess
import sys

SYSTEM_PREFIXES = ("/usr/lib/", "/System/")
MAGICS = {
    b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf",  # Mach-O 32/64 big-endian
    b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe",  # Mach-O 32/64 little-endian
    b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf",  # fat (universal)
}


def _run(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def is_macho(path):
    try:
        with open(path, "rb") as fh:
            return fh.read(4) in MAGICS
    except OSError:
        return False


def macho_files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            if is_macho(p):
                out.append(p)
    return sorted(out)


def install_id(path):
    ids = []
    for line in _run(["otool", "-D", path]).splitlines():
        s = line.strip()
        if s and not s.endswith(":"):
            ids.append(s)
    return ids


def deps(path):
    own = set(install_id(path))
    out = set()
    for line in _run(["otool", "-L", path]).splitlines():
        if line.startswith("\t"):
            d = line[1:].split(" (compatibility version")[0].strip()
            if d not in own:
                out.add(d)
    return sorted(out)


def rpaths(path):
    lines = _run(["otool", "-l", path]).splitlines()
    res = []
    for i, line in enumerate(lines):
        if line.strip() == "cmd LC_RPATH":
            for follow in lines[i + 1:i + 4]:
                s = follow.strip()
                if s.startswith("path "):
                    res.append(s[5:].split(" (offset")[0])
                    break
    return res


def _is_system(d):
    return d.startswith(SYSTEM_PREFIXES)


def _in_root(path, root):
    rp = os.path.realpath(path)
    return rp == root or rp.startswith(root + os.sep)


def _expand(path, origin):
    base = os.path.dirname(origin)
    return path.replace("@loader_path", base).replace("@executable_path", base)


def _resolve(dep, origin, root):
    """Real path of a dependency seen from ORIGIN, or None if it cannot be found.

    Absolute references resolve directly. @rpath/ and @loader_path/ resolve
    against the rpaths and directory of ORIGIN, the file the bytes came from
    (for a copied Homebrew library, its original location, not the bundle copy).
    """
    if dep.startswith("/"):
        real = os.path.realpath(dep)
        return real if os.path.exists(real) else None
    if dep.startswith("@loader_path/"):
        cand = os.path.normpath(os.path.join(os.path.dirname(origin), dep[len("@loader_path/"):]))
        return os.path.realpath(cand) if os.path.exists(cand) else None
    if dep.startswith("@rpath/"):
        leaf = dep[len("@rpath/"):]
        for r in rpaths(origin):
            cand = os.path.normpath(os.path.join(_expand(r, origin), leaf))
            if os.path.exists(cand):
                return os.path.realpath(cand)
    return None


def bundle(root):
    root = os.path.realpath(root)
    lib = os.path.join(root, "lib")
    os.makedirs(lib, exist_ok=True)
    sources = {}      # bundle name -> real source path (external libraries copied in)
    origin_of = {}    # bundle file -> the file its bytes and rpaths come from
    external = {}     # (bundle file, reference as written) -> bundle name
    todo = [(f, f) for f in macho_files(root)]
    seen = set()
    while todo:
        f, origin = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        origin_of[f] = origin
        for d in deps(f):
            if _is_system(d):
                continue
            real = _resolve(d, origin, root)
            if real is None:
                if d.startswith("@"):
                    continue  # left for check() to report if it is not inside the bundle
                raise SystemExit(f"missing dependency {d} (needed by {f})")
            if _in_root(real, root):
                continue
            name = os.path.basename(d)
            if name in sources and sources[name] != real:
                raise SystemExit(f"name clash for {name}: {sources[name]} vs {real}")
            external[(f, d)] = name
            if name in sources:
                continue
            dest = os.path.join(lib, name)
            shutil.copy2(real, dest)
            os.chmod(dest, 0o755)
            sources[name] = real
            print(f"COPIED {real} -> {dest}")
            todo.append((dest, real))

    files = macho_files(root)
    # Dylibs in lib/ first, then everything else (inside-out signing order).
    files.sort(key=lambda p: (os.path.dirname(p) != lib, p))
    changed = 0
    for f in files:
        args = []
        base = os.path.basename(f)
        for own in install_id(f):
            if own.startswith("/") and not _is_system(own) and not _in_root(own, root):
                args += ["-id", "@loader_path/" + base]
        rel = os.path.relpath(lib, os.path.dirname(f))
        for d in deps(f):
            name = external.get((f, d))
            if name is None:
                continue
            ref = "@loader_path/" + ("" if rel == "." else rel + "/") + name
            if ref != d:
                args += ["-change", d, ref]
        for r in rpaths(f):
            if r.startswith("/") and not _is_system(r) and not _in_root(r, root):
                args += ["-delete_rpath", r]
        if args:
            subprocess.run(["install_name_tool", *args, f], check=True, capture_output=True, text=True)
            changed += 1
            print(f"REWRITTEN {f}")
        if args or not _is_signed(f):
            subprocess.run(["codesign", "--force", "--sign", "-", "--timestamp=none", f],
                           check=True, capture_output=True, text=True)
            print(f"RESIGNED {f}")
    print(f"bundle: {len(sources)} libraries copied, {changed} Mach-O files rewritten and re-signed")


def _is_signed(path):
    return subprocess.run(["codesign", "--verify", "--strict", path], capture_output=True).returncode == 0


def check(root):
    root = os.path.realpath(root)
    problems = []
    files = macho_files(root)
    for f in files:
        rel = os.path.relpath(f, root)
        for d in deps(f):
            if d.startswith("@loader_path/"):
                target = os.path.normpath(os.path.join(os.path.dirname(f), d[len("@loader_path/"):]))
                if not os.path.exists(target) or not _in_root(target, root):
                    problems.append(f"{rel}: unresolved {d}")
            elif d.startswith("@rpath/"):
                leaf = d[len("@rpath/"):]
                found = False
                for r in rpaths(f):
                    base = {"@loader_path": os.path.dirname(f),
                            "@executable_path": os.path.dirname(f)}
                    expanded = r
                    for k, v in base.items():
                        expanded = expanded.replace(k, v)
                    cand = os.path.normpath(os.path.join(expanded, leaf))
                    if os.path.exists(cand) and _in_root(cand, root):
                        found = True
                        break
                if not found:
                    problems.append(f"{rel}: unresolved {d}")
            elif not _is_system(d):
                problems.append(f"{rel}: absolute reference outside the runtime: {d}")
        for own in install_id(f):
            if own.startswith("/") and not _is_system(own):
                problems.append(f"{rel}: absolute install name {own}")
        for r in rpaths(f):
            if r.startswith("/") and not _is_system(r):
                problems.append(f"{rel}: absolute LC_RPATH {r}")
        sig = subprocess.run(["codesign", "--verify", "--strict", f], capture_output=True, text=True)
        if sig.returncode != 0:
            problems.append(f"{rel}: codesign --verify failed: {sig.stderr.strip()}")
    print(f"check: {len(files)} Mach-O files under {root}")
    for p in problems:
        print("PROBLEM " + p)
    return 1 if problems else 0


def dump(root):
    root = os.path.realpath(root)
    for f in macho_files(root):
        print(f"== {os.path.relpath(f, root)}")
        own = set(install_id(f))
        for line in _run(["otool", "-L", f]).splitlines():
            # dependency lines only: otool's header repeats the path, and a dylib's first
            # entry is its own install name
            if line.startswith("\t") and line[1:].split(" (compatibility version")[0].strip() not in own:
                print(line)
    return 0


def main(argv):
    if len(argv) != 3 or argv[1] not in ("bundle", "check", "dump"):
        print(__doc__)
        return 2
    if argv[1] == "bundle":
        bundle(argv[2])
        return 0
    if argv[1] == "dump":
        return dump(argv[2])
    return check(argv[2])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
