from pathlib import Path
import base64, bz2, hashlib, json
root=Path.cwd().resolve()
parts=['1','2','3a','3b','3c']
packed=''.join((root/f'scripts/live-parity-transfer-{part}.b64').read_text().strip() for part in parts)
assert len(packed)==36188, f'Transfer length mismatch: {len(packed)}'
assert hashlib.sha256(packed.encode()).hexdigest()=='5bf81abf43c25627251eb134bf7fdb03af726a1d32a40d44022156f156238af5', 'Transfer hash mismatch'
manifest=json.loads(bz2.decompress(base64.b64decode(packed,validate=True)))
assert len(manifest)==21
tail=root/'scripts/live-parity-tailfix.json'
extra=json.loads(tail.read_text())
assert [x['path'] for x in extra]==['worker/index-clean.ts','tests/live-parity.test.ts','tests/runtime-faults.test.ts']
for batch in [manifest,extra]:
    prepared=[]
    for row in batch:
        p=(root/row['path']).resolve()
        assert p.is_relative_to(root) and '.git' not in p.relative_to(root).parts
        old=p.read_bytes() if p.exists() else b''
        assert hashlib.sha256(old).hexdigest()==row['before'], 'Base mismatch: '+row['path']
        lines=old.decode().splitlines(keepends=True)
        for start,end,text in reversed(row['edits']):
            assert 0<=start<=end<=len(lines)
            lines[start:end]=[text]
        out=''.join(lines).encode()
        assert hashlib.sha256(out).hexdigest()==row['after'], 'Target mismatch: '+row['path']
        prepared.append((p,out,row['after']))
    for p,out,digest in prepared:
        p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(out)
        print('VERIFIED',str(p.relative_to(root)),digest)
tail.unlink()
