# packages/remnawave

The typed, read-only client of the Remnawave API 3.4 and everything around it (ADR 0041): the schemas of what is read, the adapters to the views of `@swellwright/contracts`, the masking of secrets, the content hashes, the version window and the probe for what a token can read, and a fake panel for tests.

```ts
import { PanelClient, probePanel } from '@swellwright/remnawave';

const client = new PanelClient({ baseUrl: 'https://panel.example.com', token });
const probe = await probePanel(client); // version, supported or not, what the token can read
const nodes = await client.nodes(); // normalised views, secrets masked, each with a hash
client.close();
```

- **Read only by construction.** `PanelReader` has reads and nothing else; every endpoint in `PANEL_ENDPOINTS` is declared with the method `GET`. Writes come in later phases through a separate type.
- **Limits.** A deadline per request and for the connection, a cap on the answer, four requests at a time, three tries for a GET (reset, refused, 429, 5xx) with backoff and `Retry-After`, no redirect off the origin, TLS verified, plain `http:` only for a loopback or private address with an explicit flag, the address of every connection checked by the guard you pass (`addressGuard`).
- **Errors.** `PanelAuthError`, `PanelForbiddenError`, `PanelNotFoundError`, `PanelRateLimitedError`, `PanelUnavailableError`, `PanelTimeoutError`, `PanelContractError` (names the endpoint and the field), `PanelVersionError`, `PanelUrlError`, each with a stable `code`. None carries the token or a value from a response.
- **Masking.** `maskSecrets(value, { fingerprintKey })` is the only way an opaque value gets into a view. See ADR 0041 for the rules.
- **The frozen description.** `spec/remnawave-api-3.4.11.json` is the OpenAPI description of the panel 3.4.11, byte for byte. The tests check every path and method the client uses against it, that the schemas accept samples generated from it, and that the fake panel satisfies the panel's own contract package.

## The fake panel

`@swellwright/remnawave/test-support` serves the read endpoints from synthetic data (documentation names and addresses, fake secrets that say they are fake) in the process, checks the Bearer token, and can be told to refuse, throttle, fail, hang, hang up, answer with a page, redirect, send too much or answer in another shape (`inject`, `forbid`, `setToken`, `setVersion`).

```text
pnpm --filter @swellwright/remnawave run fake-panel -- --port 8801 --extra-nodes 20 --extra-hosts 20
```

prints its address and its token. To try the console against it, start the API with `SW_PANEL_ALLOW_HTTP=true` and `SW_PANEL_ALLOW_LOOPBACK=true`. `--admin-session` lets the list of API tokens through, as the panel does for an administrator session.
