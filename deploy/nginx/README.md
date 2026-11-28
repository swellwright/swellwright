# deploy/nginx

A reverse-proxy example for the compose stack in `deploy/compose` (the server listens on `127.0.0.1:3100`).

`swellwright.conf.example` terminates TLS, passes the request on and sets the two things the server relies on:

- `Host $host`: the server compares the `Origin` of every changing request with it (or with `SW_ALLOWED_ORIGINS`).
- `X-Forwarded-For $remote_addr`: **replaces** whatever the client sent. Compose requires a nonempty `SW_TRUSTED_PROXIES`. For nginx, set it to the nginx peer address as seen by the API or a CIDR reserved for trusted proxies. Do not include plugin sidecars or shared private ranges. `false` is for direct access only: behind nginx it makes all clients share the same source limits. The API warns once if it receives this header from a private peer it does not trust.

Replace the domain and the certificate paths, and restrict access (an admin network, a VPN) before exposing the console. The `/ws` block is for the terminal of a later phase.
