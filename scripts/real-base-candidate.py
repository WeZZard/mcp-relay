#!/usr/bin/env python3
"""Private trusted clone-derived observation candidate. Never runs production main/GC.
Metadata equality is not attestation, stopped-disk content proof or update prevention.
Run under pilot maintenance-lock.py; the inherited lock stays held until exit.
"""
import sys, os, json, hashlib, shutil, tempfile, importlib.util, importlib.machinery
import subprocess, threading, urllib.request, urllib.error, re
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.dont_write_bytecode = True

def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load_module(name, path):
    loader=importlib.machinery.SourceFileLoader(name,str(path))
    spec=importlib.util.spec_from_loader(name,loader)
    module=importlib.util.module_from_spec(spec); loader.exec_module(module); return module

def check_original(original, publisher, base_root):
    hashes=json.loads((original/'sha256.json').read_text())
    checks={name:dict(expected=value,actual=digest(original/name)) for name,value in hashes.items()}
    failures=[name for name,value in checks.items() if value['actual']!=value['expected']]
    before=json.loads((original/'ubuntu2404/before-fingerprint.json').read_text())
    after=json.loads((original/'ubuntu2404/after-fingerprint.json').read_text())
    current=publisher.fingerprint(base_root,'pilot-ubuntu-base','linux')
    return dict(checks=checks,failures=failures,historicalBefore=before,historicalAfter=after,current=current,
                matches=not failures and before==after==current)

def admitted(method,path,body,owned,acquired):
    if method=='GET': return path in ('/health','/images','/machines') or (owned is not None and path=='/machines/'+owned)
    if method!='POST': return False
    if path=='/acquire': return not acquired and body.get('image')=='ubuntu2404' and body.get('env')=='none' and re.fullmatch(r'relay-real-base-chain-[0-9a-f]{8}',body.get('purpose','')) is not None
    return owned is not None and path in ['/machines/'+owned+'/'+a for a in ('exec','push','pull','heartbeat','release')]

def main():
    repo,original,evidence=map(Path,sys.argv[1:4]); evidence.mkdir(parents=True,exist_ok=True)
    def save(name,value):
        p=evidence/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(value,indent=2)+'\n')
    pilot_source=repo.parent/'pilot-images'; base_root=Path.home()/'.tart/vms'
    publisher=load_module('real_publisher',pilot_source/'host/inventory.py')
    lockcheck=subprocess.run(['python3',str(pilot_source/'host/maintenance-lock.py'),'check','ubuntu2404'],capture_output=True,text=True,pass_fds=(int(os.environ['PILOT_MAINTENANCE_FD']),))
    save('lock-check.json',dict(rc=lockcheck.returncode,stdout=lockcheck.stdout,stderr=lockcheck.stderr,fd=int(os.environ['PILOT_MAINTENANCE_FD'])))
    if lockcheck.returncode: raise RuntimeError('maintainer lock check failed')
    pre=check_original(original,publisher,base_root);save('preflight-provenance.json',pre)
    if not pre['matches']: raise RuntimeError('PREALLOCATION provenance mismatch; no candidate publication or allocation permitted')
    def tart():
        r=subprocess.run(['/opt/homebrew/bin/tart','list','--format','json'],capture_output=True,text=True,timeout=15)
        save('tart-preflight.json',dict(rc=r.returncode,stdout=r.stdout,stderr=r.stderr))
        if r.returncode: raise RuntimeError('Tart inventory failed')
        return json.loads(r.stdout)
    inventory=tart(); assert any(v['Name']=='pilot-ubuntu-base' and v['State']=='stopped' and v['Running'] is False for v in inventory)
    save('base-content-before.json',{n:digest(base_root/'pilot-ubuntu-base'/n) for n in ('config.json','nvram.bin')})
    temporary=tempfile.TemporaryDirectory(prefix='real-base-candidate-');root=Path(temporary.name).resolve();pilot=root/'pilot'
    os.environ['PILOT_REPO']=str(pilot);os.environ['MACHINE_SERVICE_STATE']=str(root/'state')
    os.environ['PILOT_IMAGES_STATE_DIR']=str(root/'image-state')
    association=root/'image-state/stores'/hashlib.sha256(str(base_root.resolve()).encode()).hexdigest()/'base/ubuntu2404.json'
    target=pilot/'images/ubuntu2404/line.conf';target.parent.mkdir(parents=True);shutil.copyfile(pilot_source/'images/ubuntu2404/line.conf',target)
    save('contract.json',dict(schemaVersion=1,contract='TRUSTED clone-derived observation',notClaims=['cryptographic stopped-disk proof','attestation','prevention of boot updates'],composition='candidate discovery / existing production HTTP lifecycle',basePath=str(base_root/'pilot-ubuntu-base'),productionCatalogUsed=False,immediateEqualityRequiredBeforeSupport=True))
    publisher.bind(original/'ubuntu2404/raw-inventory.json',association,base_root,'pilot-ubuntu-base','ubuntu2404','linux',portable=pilot/'images/ubuntu2404/applications.json',mode='disposable-clone',evidence_id=original.name,collector=original/'collect.py',aliases=original/'aliases.json')
    publisher.verify(publisher.read_json(association),base_root,'pilot-ubuntu-base','ubuntu2404','linux',pilot/'images/ubuntu2404/applications.json')
    shutil.copytree(pilot,evidence/'candidate')
    shutil.copytree(root/'image-state',evidence/'candidate-image-state')
    sys.path.insert(0,str(repo.parent/'vm-service/bin'))
    service=load_module('actual_candidate_handler',repo.parent/'vm-service/bin/vm-service')
    service.initialize_application_associations(); associations=service.application_associations()
    def production(path):
        with urllib.request.urlopen('http://127.0.0.1:6240'+path,timeout=30) as r:return json.load(r)
    prod=production('/images');snap=production('/machines')
    save('production-images.json',prod);save('production-service.json',snap);save('candidate-associations.json',associations)
    assert associations['ubuntu2404']=={k:prod['images']['ubuntu2404'][k] for k in ('kind','base_vm')}
    assert Path(prod['images']['ubuntu2404']['source']).resolve()==(pilot_source/'images/ubuntu2404/line.conf').resolve()
    assert Path(snap['pilot_repo']).resolve()==pilot_source.resolve()
    assert digest(target)==digest(Path(prod['images']['ubuntu2404']['source']))
    # Freeze discovery setup; actual GET /applications executes only the real handler/catalog.
    def forbidden(*a,**kw):raise RuntimeError('candidate lifecycle/config execution forbidden')
    for name in ('_parse_line_conf','discover_lines','initialize_application_associations','tart','tart_list','acquire','release','heartbeat','guest_exec','guest_push','guest_pull','gc_once','gc_loop','main'):
        setattr(service,name,forbidden)
    service.STATE=type('ForbiddenState',(),{'read':forbidden,'update':forbidden})()
    owned=None; acquired=False; requests=[]; mutex=threading.Lock()
    class Handler(service.Handler):
        def forward(self,method):
            nonlocal owned,acquired
            raw=self.rfile.read(int(self.headers.get('Content-Length','0'))) if method=='POST' else None
            body=json.loads(raw) if raw else {}
            with mutex:
                if not admitted(method,self.path,body,owned,acquired):return self._send(403,{'error':'route/ownership refused'})
                if self.path=='/acquire':acquired=True
            request=urllib.request.Request('http://127.0.0.1:6240'+self.path,data=raw,method=method,headers={'Content-Type':'application/json'})
            try:
                response=urllib.request.urlopen(request,timeout=660)
            except urllib.error.HTTPError as e:response=e
            with response: data=response.read();status=response.code
            if self.path=='/acquire' and status==200:owned=json.loads(data)['vm']
            with mutex:
                requests.append(dict(method=method,path=self.path,requestBytes=raw.decode() if raw else None,status=status,responseBytes=data.decode()))
                save('proxy-requests.json',requests)
            self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def do_GET(self):
            if self.path=='/applications':
                with mutex: requests.append(dict(method='GET',path=self.path,handler='actual candidate applications handler'));save('proxy-requests.json',requests)
                return super().do_GET()
            return self.forward('GET')
        def do_POST(self):return self.forward('POST')
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    print(json.dumps(dict(ready=True,url=f'http://127.0.0.1:{server.server_port}',temporary=str(root),pid=os.getpid())),flush=True)
    try:
        for line in sys.stdin:
            if line.strip()=='stop':break
            raise RuntimeError('unknown candidate control')
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)
        save('base-fingerprint-after.json',publisher.fingerprint(base_root,'pilot-ubuntu-base','linux'))
        save('base-content-after.json',{n:digest(base_root/'pilot-ubuntu-base'/n) for n in ('config.json','nvram.bin')})
        if service.LOG_FILE.exists():shutil.copyfile(service.LOG_FILE,evidence/'candidate-service.log')
        temporary.cleanup();save('candidate-cleanup.json',dict(serverClosed=True,threadStopped=not thread.is_alive(),temporaryRemoved=not root.exists(),pid=os.getpid()))
if __name__=='__main__':main()
