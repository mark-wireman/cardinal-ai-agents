# Local Agent Studio IntelliJ Plugin

This module provides a true IntelliJ-native Tool Window for the agents-deployment-package workflow.

## Features

- One-click deployment trigger (`deploy-intellij.ps1`)
- Start core services (`start-services.ps1 -ServiceProfile core`)
- Build RAG index (`build-rag-index.ps1`)
- Combined start + index (`start-core-and-index.ps1`)
- Inline execution output in the Tool Window

## Open and run in IntelliJ

1. Open this module as a Gradle project from `intellij-local-agent-studio/`.
2. Let IntelliJ import Gradle sync.
3. Run Gradle Wrapper command `./gradlew runIde` (or `gradlew.bat runIde` on Windows), or run the `runIde` task from IntelliJ Gradle tool window.
4. In the launched IDE sandbox, open this repository.
5. Open the Tool Window: **Local Agent Studio**.

## Build distributable plugin

Run:

```powershell
.\gradlew.bat buildPlugin
```

The plugin ZIP is generated under:

- `intellij-local-agent-studio/build/distributions/`

Then install in IntelliJ:

1. Settings -> Plugins
2. Gear icon -> Install Plugin from Disk
3. Select the generated ZIP

## Notes

- Scripts are executed relative to the opened project root.
- This plugin targets IntelliJ Platform build line 241+ (IntelliJ 2024.1+).
- If your network injects enterprise TLS certificates and wrapper download fails with PKIX errors, run once with:

```powershell
$env:GRADLE_OPTS='-Djavax.net.ssl.trustStoreType=Windows-ROOT'
.\gradlew.bat tasks
```
