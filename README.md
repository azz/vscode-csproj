# VS Code `.csproj` Extension

This extension will prompt you to add files to the .csproj file used by Visual Studio. This is useful if you work in a team that uses both VS Code and Visual Studio.

When you switch to or save a file not in the nearest `.csproj` up the file system tree, you will prompted.

![Prompt](img/demo-prompt.png "Prompt")

Choosing "Not Now" will add an item to the status bar and stop asking you while you have the file open.

![StatusBar](img/demo-status-bar.png "Status Bar")

You can add a file to csproj via the command palette:

![Command](img/demo-command.png "Command Palette")


## Extension Settings

This extension contributes the following settings:

* `addToCsproj.enable`: Enable/disable this extension.
* `addToCsproj.itemType`: Type of element to put in the csproj file. Defaults to `Content`.

## Release Notes

### 0.0.1

Initial release.

* Support adding to nearest csproj by walking up the file system tree from current file.
* Status bar item for items temporarily ignored from csproj.
* Persistent ignore list for items not to be added to csproj.
* Caching to prevent excessive csproj reads.

### 0.1.0

* Support enable/disable configuration.
* Support custom item types. (Global setting only)
