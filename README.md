# Longshore

An illustrated, interactive guide to Kubernetes drawn as a shipping-container terminal: pods are 20-foot containers,
nodes are concrete docks with a kubelet booth, the scheduler is a gantry crane, the control plane is the harbour tower,
a Service is the kiosk and the Ingress is the gate. Every button is a real operation played out one true step at a time:
bootstrap, apply, scale, roll out, delete / crash / fail a probe, a dependency cascade (web needs api needs db), GPU
scheduling, gang scheduling (a Volcano-style PodGroup that lands by parachute), drain, send a request.

- `index.html` — the guide: fifteen chapters, each with prose, the kubectl commands and the figure preset to that scene.
- `figure/longshore.html` — the figure itself, one self-contained file. Drag to turn it, zoom, See-through, Labels.
- `src/longshore.html` + `src/core.js` — the source (a [Colorfigures](https://april-zhu.com/colorfigures) figure).
  `./build.sh` rebuilds `figure/longshore.html`.
- `tools/longshore.py` — point the figure at a real cluster (read-only; it only runs `kubectl get`).
- `demo/cluster.json` — a sample snapshot in the yard's format.

## Your own cluster

One snapshot, no server:

```bash
kubectl get nodes,pods,deploy,sts,ds,svc,ingress -A -o json > cluster.json
# open figure/longshore.html, then Cluster ▸ "open a kubectl JSON file"
```

Live, refreshed every few seconds (opens http://localhost:8788):

```bash
python3 tools/longshore.py serve --every 5
python3 tools/longshore.py serve -n shop --context prod --port 9000
```

In live mode the yard only watches: the operation buttons show the kubectl command instead of acting. New pods arrive by
crane, deleted pods fade, a cordon puts the striped tape up, probe changes switch the lamps. System pods (kube-system,
DaemonSets) are hidden until `Cluster ▸ show system pods`.

## Figure URL parameters

`?xr=1` see-through, `?labels=1` labels, `?yaw=45&pitch=35` camera, `?press=Scale>5@800,Send@2500` press buttons
after load (label, optional `>choice`, `@ms`), `?boot=1` bootstrap on load, `?web=5` / `?v2=1` / `?cache=1` / `?train=1` / `?spark=1` /
`?cordon=node-a` starting state, `?cluster=URL&poll=5` watch a snapshot URL, `?speed=4` run the simulation faster.
