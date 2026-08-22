# CA RTS

A browser multiplayer RTS built on a 512×512 cellular automaton that runs as
WebGPU compute shaders. Two players (plus spectators) share one deterministic
simulation in lockstep; see [docs/SIMULATION_AND_NETCODE.md](docs/SIMULATION_AND_NETCODE.md).

## Running the server

```
pip install -r requirements.txt
python3 server.py --port 8080
```

The server serves **HTTPS/WSS with the self-signed certificate in the repo**
(`cert.pem` / `key.pem`). WebGPU only works in secure contexts — `https://`
or `localhost` — so TLS is what makes the game reachable from other machines.
Open `https://<server-ip>:8080`, accept the certificate warning once per
machine, and share the room link. Use `--no-ssl` for plain HTTP (then only
`http://localhost` will have WebGPU). Rotate the certificate with `./gen-cert.sh`.

Chrome (or another WebGPU-capable browser) is required.

## Tests

* Unit / shader suite: open `https://localhost:8080/test.html`.
* End-to-end (two real Chrome clients): `./e2e/run.sh` (or
  `cd e2e && E2E_PORT=8080 npx playwright test`); `e2e/lockstep.spec.js`
  contains the 5-minute multiplayer acceptance test.
