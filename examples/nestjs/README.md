# netbridge × NestJS example

Minimal NestJS app showing netbridge capturing **both** HTTP stacks:

- `GET /axios-demo` — Nest `HttpService` (axios → http/https stack)
- `GET /fetch-demo` — native `fetch` (undici stack)
- `GET /aggregate` — fan-out to multiple upstreams in parallel

## Run

```bash
pnpm install
netbridge -- ts-node src/main.ts     # or: pnpm dev:netbridge
```

Open the printed netbridge UI (default http://localhost:4499), then:

```bash
curl localhost:3210/axios-demo
curl localhost:3210/fetch-demo
curl localhost:3210/aggregate
```

Watch the upstream `jsonplaceholder.typicode.com` calls appear in the UI with
full request/response bodies — traffic that is invisible in browser DevTools
because it originates in the Nest server process.
