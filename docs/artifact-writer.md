# Artifact I/O

`ArtifactWriter` is a small infrastructure boundary for safe artifact persistence.

It does not understand OpenSpec schemas, artifact names, dependency ordering, interview state, prompts, models, or review logic. OpenSpec/Core decide what should be written and where. The writer only persists UTF-8 text to a project-relative path.

`ArtifactReader` is the corresponding read boundary for persisted artifacts. Review and revision use persisted content as the target state rather than trusting a pre-write model response.

## API

```ts
await writer.write({
  projectRoot: "/path/to/project",
  path: "openspec/changes/example/capability.md",
  content: "# Capability\n",
  overwrite: false,
});

const artifact = await reader.read({
  projectRoot: "/path/to/project",
  path: "openspec/changes/example/capability.md",
});
```

Default overwrite behavior is conservative:

```text
overwrite = false
```

If a file already exists, the writer returns a `conflict` result unless `overwrite: true` is explicitly supplied.

## Safety

`NodeArtifactWriter`:

- resolves paths relative to `projectRoot`;
- rejects absolute paths and traversal outside `projectRoot`;
- creates parent directories;
- writes UTF-8 text through a temporary file then rename;
- emits semantic middleware events.

`NodeArtifactReader` uses the same project-relative path-safety principle and returns structured `read`, `not-found`, `path-rejected`, or `read-failed` results.

## Events

```text
artifact.write.before
artifact.write.after
```

Policies can deny or require human approval before persistence occurs. Middleware observes semantic artifact writes, not filesystem implementation details.
