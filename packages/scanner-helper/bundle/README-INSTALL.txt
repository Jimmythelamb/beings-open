BEINGS scanner helper for Windows
=================================

Do this on the Windows PC that has the printer and scanner.
An iPad or phone cannot run the helper.
You do not need an administrator password, git, or npm.

The usual way is the setup program, BEINGS-Scanner-Helper-Setup.exe.
This zip is the fallback if you cannot run that file.

1. Double-click BEINGS-Scanner-Helper-Setup.exe.
   If you are using this zip instead, unzip it and double-click
   Install-BEINGS-Helper.cmd.
2. If Windows SmartScreen appears, choose More info, then Run anyway.
   The file is not code-signed yet. That message is expected.
3. The setup window closes itself. It says "Installed. You can close this."
4. The helper runs in the background. There is no window to keep open.
   It also starts when you sign in to Windows.
5. On beingsvote.live, press Connect printer & scanner (Windows PC).

The installer copies the helper to:
  %LOCALAPPDATA%\BEINGS\scanner-helper

It writes install.json (version and the time it was installed) and
helper.log in that folder.

The Start menu has "Start BEINGS helper" and "Stop BEINGS helper".
The website can also start it with the beings-helper://start link.

Apps & features lists "BEINGS scanner helper" so you can uninstall it.

Printing uses Windows itself. The helper draws each page and sends it
straight to the printer you chose. It does not download another program,
and it does not open your PDF app.

The helper only listens on this computer (127.0.0.1 and ::1, port 8765).
It does not contain an upload token or a private election file.
