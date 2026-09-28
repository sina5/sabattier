#!/usr/bin/env bash
# Regenerate src-frontend/licenses/third-party.json: the license of every Rust
# crate compiled into Sabattier (Tauri included), for Settings → Open-source
# licenses. Run after changing dependencies; a backend test fails until you do.
#
# Needs: cargo-about (cargo install cargo-about --locked --features cli), python3.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

(cd "$root/src-backend" && cargo about generate --format json -o "$tmp")

python3 - "$tmp" "$root/src-backend/Cargo.lock" "$root/src-frontend/licenses/third-party.json" <<'PY'
import hashlib, json, sys
about_path, lock_path, out_path = sys.argv[1:]
about = json.load(open(about_path))
licenses = []
for lic in about["licenses"]:
    crates = sorted(
        {(u["crate"]["name"], u["crate"]["version"], u["crate"].get("repository") or "") for u in lic["used_by"]},
    )
    licenses.append({
        "id": lic["id"],
        "name": lic["name"],
        "text": lic["text"],
        "crates": [{"name": n, "version": v, "repository": r} for n, v, r in crates],
    })
licenses.sort(key=lambda l: (l["id"], l["crates"][0]["name"] if l["crates"] else ""))
out = {
    # LF endings, as the backend test hashes it (Windows checkouts use CRLF).
    "cargoLockSha256": hashlib.sha256(open(lock_path, "rb").read().replace(b"\r\n", b"\n")).hexdigest(),
    "crateCount": len({(c["name"], c["version"]) for l in licenses for c in l["crates"]}),
    "licenses": licenses,
}
json.dump(out, open(out_path, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"{out['crateCount']} crates, {len(licenses)} license texts -> {out_path}")
PY
