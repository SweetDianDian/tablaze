# Trusted files for browser tasks

Browser Use exposes `available_file_paths` for files an Agent may use. Tablaze's `run` and stdio MCP entry points now deny host-file uploads by default. An operator can allow individual existing files with repeatable `--available-file` flags:

```sh
tablaze run --provider codex --model YOUR_MODEL \
  --task 'Upload the approved report and verify the receipt.' \
  --available-file /absolute/path/report.pdf
```

Paths must be absolute. At most 20 distinct regular files of at most 50 MiB each are accepted. Directories are not grants. The CLI validates the list before browser/model work starts. The real file path is resolved and its file identity is pinned when the engine starts. A later path substitution cannot silently authorize a different file. A concurrent in-place edit of an already authorized file is outside this check; use a stable file or a stronger host sandbox when that matters.

Snapshots expose `available_files` as bounded `{ id, name, bytes, source }` records rather than revealing the operator's full paths. The Agent passes an ID such as `file:1` to a `tab_act` `upload` or `upload_chooser` action. An exact authorized path is also accepted for existing callers. Empty `files: []` still clears a file input. A completed download from the **same browser session** appears as `download:<id>` and can be uploaded without adding a host-file grant. A sibling session cannot use that alias or the downloaded path.

When a file policy is active, `tab_open.storage_state` accepts only paths previously returned by this engine's `tab_state` operation. It cannot read an arbitrary local state file. CLI `--checkpoint`/`--resume` stores browser state through its separate workspace mechanism and binds restoration to the same file-policy hash. Changing the authorized file set requires a new task; a resumed task cannot quietly gain new host files. The current CLI does not import a pre-existing external storage-state file into a restricted run; trusted applications can use the BrowserEngine SDK for that workflow.

The SDK option is `new BrowserEngine({ availableFilePaths: ['/absolute/path/report.pdf'] })`. Set it to `[]` to deny host files while retaining same-session downloaded files. Omitting this option preserves the SDK's earlier unrestricted explicit-path behavior for trusted programmatic callers. CLI `run` and stdio MCP supply `[]` when the flag is absent.

This policy limits files supplied through Tablaze's upload and storage-state tools. It is not an operating-system sandbox, a network policy, or proof that an Agent only sends authorized content. Restrict browser destinations and review the task when file contents are sensitive. The [official Browser Use Agent reference](https://docs.browser-use.com/open-source/customize/agent/all-parameters) lists its `available_file_paths` option; this document describes Tablaze's own behavior and local tests, not a matched Browser Use file-workflow result.

The [complete Node 24 + Chrome regression log](evidence/development-tests-file-policy-node24.txt) records 529/529 passing tests for this source stage. The new tests use a real local Chrome page and spawned `tablaze run` process; they make no paid model request.
