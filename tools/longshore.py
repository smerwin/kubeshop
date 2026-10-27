#!/usr/bin/env python3
"""Point the Longshore figure at a real cluster (read-only: it only ever runs `kubectl get`).

    python3 tools/longshore.py snapshot [-n NAMESPACE] [--context CTX] > cluster.json
        Writes one snapshot in the yard's format. Open figure/longshore3d.html, press Cluster > "open a kubectl JSON
        file" and pick it. (A raw `kubectl get nodes,pods,deploy,sts,ds,svc,ingress -A -o json` file loads too.)

    python3 tools/longshore.py serve [--port 8788] [--every 5] [-n NAMESPACE] [--context CTX]
        Serves the figure and a /cluster.json that is re-read from kubectl every --every seconds, then opens
        http://localhost:8788/longshore3d.html?cluster=/cluster.json&poll=5 in your browser (longshore.html is the
        same yard on the old SVG engine). New pods arrive by crane,
        deleted pods fade, cordons put the tape up: run your kubectl commands in another terminal and watch.
"""
import argparse, json, os, subprocess, sys, threading, time, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
FIG_DIR = os.path.join(HERE, '..', 'figure')
KINDS = 'nodes,pods,deployments,statefulsets,daemonsets,services,ingresses'


def kubectl_json(args):
    cmd = ['kubectl', 'get', KINDS, '-o', 'json']
    cmd += ['-A'] if not args.namespace else ['-n', args.namespace]
    if args.context:
        cmd += ['--context', args.context]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or 'kubectl failed')
    return json.loads(out.stdout)


def app_of(meta):
    labels = meta.get('labels') or {}
    for key in ('app', 'app.kubernetes.io/name', 'k8s-app'):
        if labels.get(key):
            return labels[key]
    owners = meta.get('ownerReferences') or []
    if owners:
        name = owners[0].get('name', '')
        if owners[0].get('kind') == 'ReplicaSet':
            parts = name.rsplit('-', 1)
            return parts[0] if len(parts) == 2 and 6 <= len(parts[1]) <= 10 else name
        return name
    return meta.get('name', 'pod')


def normalize(raw, context):
    snap = {'context': context, 'fetched': time.strftime('%Y-%m-%dT%H:%M:%S'), 'nodes': [], 'pods': [], 'deployments': [], 'services': [], 'ingresses': []}
    for item in raw.get('items', []):
        kind, meta, spec, status = item.get('kind'), item.get('metadata', {}), item.get('spec', {}), item.get('status', {})
        if kind == 'Node':
            ready = any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in status.get('conditions', []))
            snap['nodes'].append({'name': meta['name'], 'ready': ready, 'cordoned': bool(spec.get('unschedulable')),
                                  'gpus': int((status.get('allocatable') or {}).get('nvidia.com/gpu', 0) or 0)})
        elif kind == 'Pod':
            cs = status.get('containerStatuses') or []
            owners = meta.get('ownerReferences') or []
            vols = spec.get('volumes') or []
            first_image = (spec.get('containers') or [{}])[0].get('image', '')
            labels = meta.get('labels') or {}
            version = labels.get('version') or labels.get('app.kubernetes.io/version')
            if not version:
                version = owners[0]['name'].rsplit('-', 1)[-1] if owners and owners[0].get('kind') == 'ReplicaSet' else (first_image.split(':')[1] if ':' in first_image else 'v1')
            waiting = [c.get('state', {}).get('waiting', {}).get('reason') for c in cs]
            phase = status.get('phase', 'Unknown')
            if 'CrashLoopBackOff' in waiting:
                phase = 'CrashLoopBackOff'
            gpu = sum(int(((c.get('resources') or {}).get('limits') or {}).get('nvidia.com/gpu', 0) or ((c.get('resources') or {}).get('requests') or {}).get('nvidia.com/gpu', 0) or 0) for c in spec.get('containers', []))
            snap['pods'].append({
                'name': meta['name'], 'namespace': meta.get('namespace'), 'node': spec.get('nodeName'), 'app': app_of(meta), 'phase': phase, 'gpu': gpu,
                'ready': bool(cs) and all(c.get('ready') for c in cs), 'restarts': sum(c.get('restartCount', 0) for c in cs),
                'containers': [{'name': c['name'], 'image': c.get('image', '')} for c in spec.get('containers', [])], 'version': version,
                'pvc': next((v['name'] for v in vols if v.get('persistentVolumeClaim')), None),
                'configMap': next((v['name'] for v in vols if v.get('configMap')), None),
                'secret': next((v['name'] for v in vols if v.get('secret')), None),
                'system': meta.get('namespace') == 'kube-system' or (bool(owners) and owners[0].get('kind') == 'DaemonSet')})
        elif kind in ('Deployment', 'StatefulSet', 'DaemonSet'):
            sel = (spec.get('selector') or {}).get('matchLabels') or {}
            tpl = (spec.get('template') or {}).get('spec') or {}
            first_image = (tpl.get('containers') or [{}])[0].get('image', '')
            snap['deployments'].append({
                'name': meta['name'], 'namespace': meta.get('namespace'), 'kind': kind,
                'app': sel.get('app') or sel.get('app.kubernetes.io/name') or sel.get('k8s-app') or meta['name'],
                'replicas': spec.get('replicas', status.get('desiredNumberScheduled', 0)), 'ready': status.get('readyReplicas', status.get('numberReady', 0)),
                'version': first_image.split(':')[1] if ':' in first_image else 'v1',
                'containers': [{'name': c['name'], 'image': c.get('image', '')} for c in tpl.get('containers', [])],
                'system': meta.get('namespace') == 'kube-system' or kind == 'DaemonSet'})
        elif kind == 'Service':
            snap['services'].append({'name': meta['name'], 'namespace': meta.get('namespace'), 'selector': spec.get('selector') or {}, 'ports': [p.get('port') for p in spec.get('ports', [])]})
        elif kind == 'Ingress':
            for rule in spec.get('rules', []):
                paths = (rule.get('http') or {}).get('paths') or [{}]
                backend = (paths[0].get('backend') or {}).get('service') or {}
                snap['ingresses'].append({'host': rule.get('host', '*'), 'service': backend.get('name'), 'port': (backend.get('port') or {}).get('number')})
    # the Service an Ingress points at goes first, so the kiosk shows it
    snap['services'].sort(key=lambda s: 0 if any(i.get('service') == s['name'] for i in snap['ingresses']) else 1)
    return snap


def current_context(args):
    if args.context:
        return args.context
    out = subprocess.run(['kubectl', 'config', 'current-context'], capture_output=True, text=True)
    return out.stdout.strip() or 'cluster'


def cmd_snapshot(args):
    json.dump(normalize(kubectl_json(args), current_context(args)), sys.stdout, indent=1)
    sys.stdout.write('\n')


def cmd_serve(args):
    state = {'json': json.dumps({'context': current_context(args), 'nodes': [], 'pods': []}).encode(), 'error': ''}

    def refresh():
        while True:
            try:
                state['json'] = json.dumps(normalize(kubectl_json(args), current_context(args))).encode()
                state['error'] = ''
            except Exception as e:  # keep serving the last good snapshot
                state['error'] = str(e)
                print('kubectl:', e, file=sys.stderr)
            time.sleep(max(1, args.every))

    threading.Thread(target=refresh, daemon=True).start()

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=FIG_DIR, **kw)

        def do_GET(self):
            if self.path.split('?')[0] == '/cluster.json':
                body = state['json']
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

        def log_message(self, *a):
            pass

    url = f'http://localhost:{args.port}/longshore3d.html?cluster=/cluster.json&poll={args.every}'
    print('Longshore watching', current_context(args), 'at', url)
    if not args.no_open:
        webbrowser.open(url)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('snapshot', 'serve'):
        p = sub.add_parser(name)
        p.add_argument('-n', '--namespace', help='one namespace (default: all)')
        p.add_argument('--context', help='kubectl context (default: current)')
        if name == 'serve':
            p.add_argument('--port', type=int, default=8788)
            p.add_argument('--every', type=int, default=5, help='seconds between kubectl reads')
            p.add_argument('--no-open', action='store_true', help="don't open the browser")
    args = ap.parse_args()
    try:
        (cmd_snapshot if args.cmd == 'snapshot' else cmd_serve)(args)
    except RuntimeError as e:
        sys.exit(f'error: {e}')
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
