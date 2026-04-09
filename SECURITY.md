# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < Latest | No       |

Only the latest released version receives security updates.

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email **security@openaccountant.ai** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to expect

- **Acknowledgment** within 48 hours
- **Assessment** within 7 days
- **Fix or mitigation** within 90 days

We will coordinate disclosure with you and credit reporters who follow responsible disclosure.

## Scope

- The Wilson CLI application and its dependencies
- Local SQLite database handling
- Credential and license key storage
- Subprocess execution (agent loop, tool calls)

## Out of Scope

- Social engineering attacks
- Denial of service attacks
- Issues in third-party dependencies with existing CVEs (report upstream)
- Vulnerabilities requiring physical access to the machine
