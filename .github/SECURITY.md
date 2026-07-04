# Security Policy

## Supported Versions

The latest published `1.x` release receives security fixes.

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(the "Report a vulnerability" button on the Security tab), or by email to
**m@carrillo.app**.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce or a proof of concept.
- Affected version(s).

You can expect an initial acknowledgement within 5 business days. We will keep
you informed of the remediation progress and coordinate disclosure once a fix
is available.

## Scope notes

DocGraph indexes local files and, when a cloud embedding provider is configured,
sends document chunks to that provider's API. Review your `.docgraph/settings.json`
and exclude patterns before indexing repositories that contain secrets. The
built-in `local` provider keeps all data on your machine.
