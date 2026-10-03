# ii Engine launch readiness

Last audited: 2026-09-15 against `work/reference-pack/00_READ_FIRST/ii-engine-final-build-prompt.txt`.

## Working now

- Windows Tauri shell, frameless draggable title bar, tray menu, close-to-tray behavior, React dashboard, reduced-motion setting, and local demo.
- Railway production API and PostgreSQL schema revision `0003`, with liveness and readiness checks.
- Discord OAuth, guild membership lookup, staff-role mapping, Engine User role assignment, rotating sessions, signout, and disconnect logic. A live member login completed successfully.
- NVIDIA-backed private iiGPT route with streaming and a ten-successful-request daily quota.
- Sanitized Discord announcement cache, live-menu count cache, and unavailable/stale states.
- Steam library discovery, local health inspection, pinned BepInEx 5.4.23.4 verification, signed-manifest verification, scoped installation, verified backup creation, operation journal, Steam launch, and native tests.
- Developer content drafts and release synchronization. Publishing remains locked by the production feature flag.
- Pinned CI, dependency audits, source-boundary checks, SBOM generation, MSI and NSIS packaging.

## Must finish before public launch

1. **Backup and repair screens — complete.** Native inventory, reviewed restore, safety snapshot, journal resume, targeted repair and Advanced full repair are connected to the desktop UI.
2. **Publish one signed stable manifest.** Run the protected GitHub signing workflow for the approved menu release, review its artifact, import it through the Developer panel, and enable production publication only for the reviewed window. Confirm the desktop can fetch and verify that exact manifest.
3. **Live provider checks.** Test both configured announcement channels, updates, live count, iiGPT streaming/quota, staff-only access, ordinary-member access, nonmember Join Server, signout, and disconnect. Use controlled accounts and do not publish announcements during the test.
4. **Fresh Windows acceptance.** On a clean Windows 10/11 x64 account or VM, install the NSIS and MSI builds, verify WebView2/prerequisite handling, Discord login, non-default Steam discovery, DPI/keyboard behavior, tray behavior, uninstall, and retained backups. Run one reviewed install/launch/repair/restore cycle against a test Gorilla Tag installation.
5. **Retention and account deletion — application complete.** Daily cleanup and authenticated erasure are implemented and tested. Confirm Railway PostgreSQL backup retention is 30 days.
6. **Legal release fields — filled for owner review.** Drifted, the public contact, effective date, retention periods, source URLs and deletion process are in the documents.
7. **Release artifacts — automated.** A manual artifact-only workflow builds NSIS/MSI, checksums, SBOM, notices and GPL source without permission to publish a release. The owner approved an unsigned first release.
8. **Provider credentials.** The owner reviewed the current provider credentials on 2026-09-15 and directed the project to retain them.

## Inputs still needed from the owner

- Legal operator name, public support/privacy contact, and policy effective date.
- Retention periods and deletion-request procedure.
- A clean Windows test account or VM and permission for the controlled game install/repair/restore test.
- A Windows code-signing certificate, or an explicit decision to ship an unsigned first release.
- Final approval to enable managed-content publication, publish the first GitHub release, and post the prepared Discord update. These are separate final actions.

No new menu DLL is required for routine updates. Maintainers publish the official menu release, run the signing workflow, and import the resulting signed manifest through ii Engine's Developer panel.
