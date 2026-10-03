# Repair and recovery model

Rust owns all filesystem operations. No webview command accepts arbitrary shell commands, download URLs, deletion roots, or backup destinations. The signed stable install command is enabled in the Windows app; restore and interrupted-operation recovery still need their final reviewed command and UI flow.

Scope is limited to BepInEx, iisStupidMenu and the approved root bootstrap files `winhttp.dll` and `doorstop_config.ini`. Even a supplied bootstrap list cannot authorize Gorilla Tag.exe, UnityPlayer.dll or Gorilla Tag_Data. Relative paths reject traversal, absolute paths, Windows device names, alternate data streams and invalid components. Existing root ancestors and descendants are checked for symlinks/junctions.

The backup primitive inventories exact relative paths, directories, byte sizes and SHA-256 hashes. It rejects overlapping scopes and bounded scan/size-limit violations. It verifies the current tree still matches the preview before copying, flushes and verifies the saved payload, then checks the original tree again. Any change stops the operation. Operation locks use an OS file lock released when the process exits; an existing lock filename is not itself treated as an active lock.

Targeted repair must preserve unrelated mods. Duplicate ii DLLs require actual managed BepInPlugin GUID metadata; matching strings are insufficient. Full repair requires an explicit second confirmation and retains the entire approved scope, including preferences and InstallId, in a private local backup.

Remaining implementation gates: complete approved baseline and staged-tree verification; same-volume swaps with persistent intent journals; resume/rollback after interruption; restore preview and safety snapshot; successful-operation marker and keep-last-three pruning; disk-space and narrow elevation handling; native adversarial fixture tests. No current UI button claims those operations are complete.
