# Security policy

## Supported versions

There are no releases yet (pre-alpha implementation). Once released, the latest minor version receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub: the **Security** tab, then **Report a vulnerability** (private vulnerability reporting).

Include a description, affected component and version, reproduction steps and the impact. Do not include real credentials, IP addresses or domains of a live deployment; use placeholders.

We aim to acknowledge reports within 7 days, provide an assessment within 14 days and coordinate disclosure; a fix or mitigation is targeted within 90 days.

## Scope

In scope: the Swellwright API, worker, web UI, CLI, probe agent, official plugins, container images, default deployment files, documentation that could lead to insecure configuration.

Out of scope: vulnerabilities in Remnawave itself (report them to that project), third-party plugins not in this repository, social engineering, denial of service by resource exhaustion on a self-hosted instance without a security impact.

## Handling secrets

Swellwright stores secrets in an encrypted vault and redacts them from logs and events. If you find a path where a secret value can leak (logs, events, API responses, backups, errors), treat it as a vulnerability.
