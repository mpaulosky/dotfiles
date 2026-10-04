# Per-repo additions

A `<repo>.json` here adds to the standard for one repo, and may only add:

```json
{"required_checks": ["Sandcastle"], "labels": [{"name": "…", "color": "…", "description": "…"}]}
```

Any other key is an error, so no repo can loosen the standard. See `references/github-settings.md`.
