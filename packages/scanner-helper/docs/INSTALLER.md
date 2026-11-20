# Windows setup program

Teachers install the scanner helper by double-clicking one file: `BEINGS-Scanner-Helper-Setup.exe`.

The setup program is a per-user NSIS installer (`windows/installer/beings-helper.nsi`). It does not ask for an administrator password. It is built with `makensis`, which runs on Linux and on Windows, so CI can rebuild it.

```
node packages/scanner-helper/tools/build-windows-installer.mjs
```

That command:

1. Stages the same helper files as the zip fallback.
2. Downloads the pinned official Node.js Windows x64 zip (`tools/node-win-x64.json`) and checks its SHA256 against the checksum published by nodejs.org.
3. Puts `node.exe` in the setup program so the teacher's PC does not need Node already, and does not need a second download during install.
4. Compiles `BEINGS-Scanner-Helper-Setup.exe`.
5. Writes the exe, its SHA256, and the version into `apps/beingsvote-site/public/downloads/`.

The exe is what the site offers. `BEINGS-Scanner-Helper-Windows.zip` stays as a fallback for a PC where the setup program cannot run.

What the setup program does on the teacher's PC:

* Stops a helper that is already running, then replaces `%LOCALAPPDATA%\BEINGS\scanner-helper`.
* Writes `install.json` with `version` and `installedAt`, and appends a line to `helper.log`.
* Registers sign-in start under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
* Adds Start menu shortcuts named **Start BEINGS helper** and **Stop BEINGS helper**.
* Registers the per-user link `beings-helper://start` so the website can start the helper.
* Starts the helper with `wscript.exe //B` so no console window stays open.
* Adds an uninstall entry that Windows shows in Apps & features.
* Shows "Installed. You can close this." and closes itself after a few seconds.

Code signing is not set up. There is no certificate and no CI secret for one. Windows SmartScreen can say the publisher is unknown. The teacher chooses **More info**, then **Run anyway**. Signing can be added later without changing the install steps.

GitHub Actions workflow `.github/workflows/scanner-helper-installer.yml` installs NSIS and runs the same build. It does not publish a release and it does not deploy the website.
