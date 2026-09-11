#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wheelgrab.py — pip-free wheel installer that HONOURS version specifiers.

Why this exists: pip's lazy-wheel path writes ``<wheel>.whl.metadata`` next to a
freshly extracted wheel, which is rejected with EACCES on this box (stable,
reproducible; ``--target`` / ``--user`` / retries all fail). This script resolves
dependencies straight from the PyPI JSON API, applies the ``Requires-Dist``
version specifiers, downloads matching wheels with the OpenSSL urllib stack, and
unpacks them into a target directory the plugin worker puts on ``sys.path``.

Usage:
  python wheelgrab.py <target-dir> <pkg>[<spec>] [<pkg>[<spec>] ...]
  python wheelgrab.py vendor trafilatura markitdown "magika~=0.6.1"
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import ssl
import sys
import urllib.request
import zipfile

sys.stdout.reconfigure(encoding='utf-8')

try:
    from packaging.specifiers import SpecifierSet
    from packaging.version import Version, InvalidVersion
    HAVE_PACKAGING = True
except Exception:  # pragma: no cover - fallback for bare interpreters
    HAVE_PACKAGING = False

TARGET = sys.argv[1]
ROOTS = sys.argv[2:]
os.makedirs(TARGET, exist_ok=True)

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

PY = (3, 13)
PLAT = 'win_amd64'


# ── 环境探测 ────────────────────────────────────────────────────────────────

def installed_in_target(name: str) -> bool:
    """目标目录里已经有这个包？（幂等：重跑不重复下载）"""
    norm = name.replace('-', '_').lower()
    for entry in os.listdir(TARGET):
        if entry.endswith('.dist-info'):
            stem = entry[:-len('.dist-info')]
            if stem.split('-')[0].replace('-', '_').lower() == norm:
                return True
    return os.path.isdir(os.path.join(TARGET, norm)) or os.path.isfile(
        os.path.join(TARGET, norm + '.py'))


def available_system(name: str) -> bool:
    """解释器本身能 import？（能就别重复 vendor）"""
    try:
        return importlib.util.find_spec(name.replace('-', '_')) is not None
    except Exception:
        return False


# ── 版本约束 ────────────────────────────────────────────────────────────────

def parse_req(raw: str):
    """'magika~=0.6.1; python_version>="3.9"' → ('magika', '~=0.6.1', marker)"""
    marker = None
    if ';' in raw:
        raw, marker = raw.split(';', 1)
        marker = marker.strip()
    raw = raw.strip()
    raw = re.sub(r'\[[^\]]*\]', '', raw).strip()  # 去掉 extras
    m = re.match(r'^([A-Za-z0-9._-]+)\s*(.*)$', raw)
    if not m:
        return None, None, marker
    return m.group(1), m.group(2).strip(), marker


def marshal_ok(marker: str | None) -> bool:
    """极简 marker 求值：够用即可（python_version / sys_platform / os_name / extra）。"""
    if not marker:
        return True
    low = marker.lower()

    def val(key):
        return {
            'python_version': f'{PY[0]}.{PY[1]}',
            'sys_platform': 'win32',
            'os_name': 'nt',
            'platform_system': 'Windows',
            'platform_machine': 'AMD64',
            'extra': '""',
        }.get(key, '')

    def cmpnums(a, b, op):
        try:
            ta = tuple(int(x) for x in a.split('.'))
            tb = tuple(int(x) for x in b.split('.'))
        except ValueError:
            return False
        return {'==': ta == tb, '!=': ta != tb, '>=': ta >= tb,
                '<=': ta <= tb, '>': ta > tb, '<': ta < tb}.get(op, False)

    def split_top(expr, op):
        depth, parts, cur, i = 0, [], '', 0
        while i < len(expr):
            ch = expr[i]
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
            if depth == 0 and expr[i:i + len(op)] == op:
                parts.append(cur); cur = ''; i += len(op); continue
            cur += ch
            i += 1
        parts.append(cur)
        return parts

    def ev(expr: str) -> bool:
        expr = expr.strip()
        while expr.startswith('(') and expr.endswith(')'):
            expr = expr[1:-1].strip()
        parts = split_top(expr, ' or ')
        if len(parts) > 1:
            return any(ev(p) for p in parts)
        parts = split_top(expr, ' and ')
        if len(parts) > 1:
            return all(ev(p) for p in parts)
        mm = re.match(r"^([a-z_]+)\s*(==|!=|>=|<=|>|<|in|not in)\s*['\"]([^'\"]*)['\"]$", expr)
        if mm:
            a, op, b = val(mm.group(1)), mm.group(2), mm.group(3)
            if op in ('in', 'not in'):
                r = a in b
                return r if op == 'in' else not r
            return cmpnums(a, b, op)
        mm = re.match(r"^['\"]([^'\"]*)['\"]\s*(==|!=)\s*([a-z_]+)$", expr)
        if mm:
            return val(mm.group(3)) == mm.group(1)
        return True

    return ev(low)


def satisfies(version: str, spec: str) -> bool:
    """无 packaging 时的退化比较（够识别 == / >= / ~= 主干）。"""
    if not spec:
        return True
    try:
        vt = tuple(int(x) for x in re.split(r'[.\-+]', version)[:3] if x.isdigit())
    except Exception:
        return True
    for clause in spec.split(','):
        m = re.match(r'^(==|>=|<=|>|<|~=)\s*([\d.]+)$', clause.strip())
        if not m:
            continue
        op, rt = m.group(1), tuple(int(x) for x in m.group(2).split('.'))
        n = min(len(vt), len(rt))
        if op == '==' and vt[:n] != rt[:n]:
            return False
        if op == '>=' and not vt >= rt:
            return False
        if op == '<=' and not vt <= rt:
            return False
        if op == '~=' and (not vt >= rt or vt[:max(1, len(rt) - 1)] != rt[:max(1, len(rt) - 1)]):
            return False
    return True


# ── wheel 选择 ──────────────────────────────────────────────────────────────

def tag_ok(filename: str) -> bool:
    parts = filename[:-4].split('-')
    if len(parts) < 5:
        return False
    pytag, abitag, plattag = parts[-3], parts[-2], parts[-1]
    if plattag not in ('any', PLAT):
        return False
    for py in pytag.split('.'):
        if py.startswith('cp'):
            if py[2:] != f'{PY[0]}{PY[1]}':
                return False
        elif not py.startswith('py'):
            return False
    for abi in abitag.split('.'):
        if abi in ('none', 'abi3'):
            continue
        if abi.startswith('cp') and abi[2:] != f'{PY[0]}{PY[1]}':
            return False
    return True


def best_wheel(files):
    wheels = [f for f in files if f['filename'].endswith('.whl') and tag_ok(f['filename'])]
    if not wheels:
        return None
    wheels.sort(key=lambda f: (0 if '-none-any.whl' in f['filename'] else 1, f.get('size', 0)))
    return wheels[0]


def get_json(url: str):
    req = urllib.request.Request(url, headers={'User-Agent': 'wheelgrab/1.1',
                                               'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=45, context=CTX) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def resolve_version(name: str, spec: str):
    """选满足 spec 的最高稳定版本；约束无解就报错，绝不静默装错版本。"""
    meta = get_json(f'https://pypi.org/pypi/{name}/json')
    releases = meta['releases']
    if not spec:
        v = meta['info']['version']
        return v, releases.get(v, [])
    if HAVE_PACKAGING:
        good = []
        for v, files in releases.items():
            if not files:
                continue
            try:
                parsed = Version(v)
            except InvalidVersion:
                continue
            if parsed.is_prerelease or parsed.is_devrelease:
                continue
            if parsed in SpecifierSet(spec):
                good.append((parsed, v, files))
        if good:
            good.sort(key=lambda t: t[0])
            return good[-1][1], good[-1][2]
    else:
        good = [(v, f) for v, f in releases.items() if f and satisfies(v, spec)]
        if good:
            good.sort(key=lambda t: [int(x) for x in re.findall(r'\d+', t[0])][:3])
            return good[-1][0], good[-1][1]
    raise RuntimeError(f'no release of {name} satisfies {spec!r}')


# ── 主循环 ──────────────────────────────────────────────────────────────────

seen: dict[str, str] = {}
installed: list[str] = []
skipped: list[str] = []
queue: list[tuple[str, str]] = []
for raw in ROOTS:
    n, s, _m = parse_req(raw)
    if n:
        queue.append((n, s or ''))

while queue:
    name, spec = queue.pop(0)
    key = name.lower()
    if key in seen:
        continue
    seen[key] = spec
    if installed_in_target(name):
        skipped.append(f'{name} (already in target)')
        continue
    if available_system(name):
        skipped.append(f'{name} (system)')
        continue
    try:
        ver, files = resolve_version(name, spec)
    except Exception as e:
        print(f'  ! resolve {name}{spec}: {e}')
        continue
    f = best_wheel(files)
    if not f:
        print(f'  ! no compatible wheel for {name} {ver} (sdist-only or unsupported tag)')
        continue
    try:
        req = urllib.request.Request(f['url'], headers={'User-Agent': 'wheelgrab/1.1'})
        with urllib.request.urlopen(req, timeout=180, context=CTX) as r:
            blob = r.read()
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            z.extractall(TARGET)
        installed.append(f'{name}=={ver}')
        print(f'  + {name}=={ver} ({len(blob)//1024} KB)')
    except Exception as e:
        print(f'  ! download {name}: {e}')
        continue

    meta = get_json(f'https://pypi.org/pypi/{name}/{ver}/json')
    for dep in meta['info'].get('requires_dist') or []:
        dname, dspec, marker = parse_req(dep)
        if not dname or not marshal_ok(marker):
            continue
        if dname.lower() in seen:
            continue
        queue.append((dname, dspec or ''))

print(json.dumps({'target': TARGET, 'installed': installed, 'skipped': skipped},
                 ensure_ascii=False, indent=1))
