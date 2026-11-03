#!/usr/bin/env python3
"""Private trusted clone-derived observation candidate (DC-7x-LIVE-2).

Binds a candidate catalog for one sealed historical inventory into the
catalog folders a second instance's daemon reads, which lie under the
instance's own root, and holds pilot-images' maintenance lock until told to
stop. It reads the base in the instance's Tart store and never writes it.
The instance serves the catalog; there is no proxy and no installed instance.
Metadata equality is not attestation, stopped-disk content proof or update
prevention. Run under pilot maintenance-lock.py; the inherited lock stays
held until exit.

  real-base-candidate.py <repo> <original> <evidence> <instance-root> <tart>
"""
import sys, os, json, hashlib, shutil, subprocess, importlib.util, importlib.machinery
from pathlib import Path
sys.dont_write_bytecode = True

IMAGE, BASE, KIND = 'ubuntu2404', 'pilot-ubuntu-base', 'linux'
MANIFEST = 'second-instance.json'

def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load_module(name, path):
    loader=importlib.machinery.SourceFileLoader(name,str(path))
    spec=importlib.util.spec_from_loader(name,loader)
    module=importlib.util.module_from_spec(spec); loader.exec_module(module); return module

def within(path, root):
    return path == root or root in path.parents

def instance_catalog(manifest, root):
    """The instance's Tart store and the catalog folders its daemon reads,
    refused unless the manifest is this root's, marks a second instance and
    names both folders under the root (scripts/second-instance.mjs)."""
    root = Path(root).resolve()
    env = manifest.get('env') if isinstance(manifest, dict) else None
    if not isinstance(env, dict) or not isinstance(manifest.get('id'), str) or env.get('MACHINE_SERVICE_SECOND_INSTANCE') != manifest['id']:
        raise ValueError('manifest of no marked second instance')
    if Path(str(manifest.get('root', ''))).resolve() != root:
        raise ValueError('manifest of another root')
    store = manifest.get('tart_home')
    if not isinstance(store, str) or not os.path.isabs(store) or env.get('TART_HOME') != store or env.get('TART_NO_AUTO_PRUNE') != '1':
        raise ValueError('the daemon does not run on the manifest Tart store with auto-prune off')
    folders = {}
    for name in ('PILOT_REPO', 'PILOT_IMAGES_STATE_DIR'):
        value = env.get(name)
        if not isinstance(value, str) or not os.path.isabs(value):
            raise ValueError(f'the instance names no {name}')
        folder = Path(value).resolve()
        if folder == root or not within(folder, root):
            raise ValueError(f'{name} {value} lies outside the instance root')
        folders[name] = folder
    return dict(store=Path(store).resolve(), pilot=folders['PILOT_REPO'], image_state=folders['PILOT_IMAGES_STATE_DIR'])

def check_original(original, publisher, base_root):
    hashes=json.loads((original/'sha256.json').read_text())
    checks={name:dict(expected=value,actual=digest(original/name)) for name,value in hashes.items()}
    failures=[name for name,value in checks.items() if value['actual']!=value['expected']]
    before=json.loads((original/IMAGE/'before-fingerprint.json').read_text())
    after=json.loads((original/IMAGE/'after-fingerprint.json').read_text())
    current=publisher.fingerprint(base_root,BASE,KIND)
    return dict(checks=checks,failures=failures,historicalBefore=before,historicalAfter=after,current=current,
                matches=not failures and before==after==current)

def main():
    repo,original,evidence,instance_root,tart=map(Path,sys.argv[1:6]); evidence.mkdir(parents=True,exist_ok=True)
    def save(name,value):
        p=evidence/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(value,indent=2)+'\n')
    catalog=instance_catalog(json.loads((instance_root/MANIFEST).read_text()),instance_root)
    store=catalog['store']; base_root=store/'vms'; pilot=catalog['pilot']; image_state=catalog['image_state']
    pilot_source=repo.parent/'pilot-images'
    publisher=load_module('real_publisher',pilot_source/'host/inventory.py')
    fd=int(os.environ['PILOT_MAINTENANCE_FD'])
    lockcheck=subprocess.run([sys.executable,str(pilot_source/'host/maintenance-lock.py'),'check',IMAGE],capture_output=True,text=True,pass_fds=(fd,))
    save('lock-check.json',dict(rc=lockcheck.returncode,stdout=lockcheck.stdout,stderr=lockcheck.stderr,fd=fd))
    if lockcheck.returncode: raise RuntimeError('maintainer lock check failed')
    pre=check_original(original,publisher,base_root);save('preflight-provenance.json',pre)
    if not pre['matches']: raise RuntimeError('PREALLOCATION provenance mismatch; no candidate publication or allocation permitted')
    # Read-only: the store's inventory, with the instance's own store and auto-prune off.
    r=subprocess.run([str(tart),'list','--format','json'],capture_output=True,text=True,timeout=15,env=dict(PATH='/usr/bin:/bin',HOME=os.environ.get('HOME','/var/empty'),TART_HOME=str(store),TART_NO_AUTO_PRUNE='1'))
    save('tart-preflight.json',dict(rc=r.returncode,stdout=r.stdout,stderr=r.stderr))
    if r.returncode: raise RuntimeError('Tart inventory failed')
    if not any(v['Name']==BASE and v['State']=='stopped' and v['Running'] is False for v in json.loads(r.stdout)): raise RuntimeError(f'{BASE} is not a stopped VM in the instance store')
    save('base-content-before.json',{n:digest(base_root/BASE/n) for n in ('config.json','nvram.bin')})
    association=image_state/'stores'/hashlib.sha256(str(base_root.resolve()).encode()).hexdigest()/'base'/f'{IMAGE}.json'
    target=pilot/'images'/IMAGE/'line.conf';target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(pilot_source/'images'/IMAGE/'line.conf',target)
    save('contract.json',dict(schemaVersion=2,contract='TRUSTED clone-derived observation',notClaims=['cryptographic stopped-disk proof','attestation','prevention of boot updates'],composition='candidate catalog served by the second instance / production HTTP lifecycle',basePath=str(base_root/BASE),pilotRepo=str(pilot),imageState=str(image_state),productionCatalogUsed=False,immediateEqualityRequiredBeforeSupport=True))
    publisher.bind(original/IMAGE/'raw-inventory.json',association,base_root,BASE,IMAGE,KIND,portable=pilot/'images'/IMAGE/'applications.json',mode='disposable-clone',evidence_id=original.name,collector=original/'collect.py',aliases=original/'aliases.json')
    publisher.verify(publisher.read_json(association),base_root,BASE,IMAGE,KIND,pilot/'images'/IMAGE/'applications.json')
    shutil.copytree(pilot,evidence/'pilot');shutil.copytree(image_state,evidence/'image-state')
    print(json.dumps(dict(ready=True,pilotRepo=str(pilot),imageState=str(image_state),store=str(store),pid=os.getpid())),flush=True)
    try:
        for line in sys.stdin:
            if line.strip()=='stop':break
            raise RuntimeError('unknown candidate control')
    finally:
        save('base-fingerprint-after.json',publisher.fingerprint(base_root,BASE,KIND))
        save('base-content-after.json',{n:digest(base_root/BASE/n) for n in ('config.json','nvram.bin')})
if __name__=='__main__':main()
