# Project Instructions

## Identity

- Project codename: Pocket Harness.

## Architecture

- Executable learning fixtures are self-contained files in `/workspace`.
- Keep verification code colocated with each tiny fixture; do not create separate imported test modules.

## Verification

- Use `js-exec /workspace/<file>.js` for JavaScript fixtures.
- `node`, `npm`, and external binaries are unavailable inside this virtual workspace.
- Report the exact command, stdout or stderr, and exit code.
