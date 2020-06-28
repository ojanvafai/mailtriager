# MakeTime
Make-time is an opinionated email client for Gmail.

Contributions in the form of filing bugs or pull requests for anything ranging from
typo fixes to substantial changes are very welcome.

## Install dependencies
1. Checkout https://github.com/ojanvafai/make-time
2. installs type script, firebase, gulp, etc:
```
npm install
```
3. Firebase serving needs permissions to start even a local server. To get these permissions,
join this mailing list: https://groups.google.com/forum/#!forum/make-time.
4. Login to firebase:
```
$ ./node_modules/firebase-tools/lib/bin/firebase.js login
```
5. [Optional] Install Visual Studio Code. It work particularly well with typescript integration. See https://stackoverflow.com/posts/30319507/revisions.

## Starting a dev server
For the dev server to work, you need to both start the firebase server and
compile typescript after every change. You can run both with the following command:
```
$ ./gulp serve
```

Start http://localhost:5000 serves make-time for consumer accounts, and http://localhost:8000 for google.com accounts.

### Flags for serving
--bundle to also generate the bundled/minified JS on each file change.

## Deploying
```
$ ./gulp deploy
```

Or for Google instance:
```
$ ./gulp deploy-google
```

In order to deploy, Ojan will need to make you a collaborator on the relevant
appengine projects first.

## Bundling
By default, running locally will serve unbundled and deploying will bundle.
You can override the default behavior (locally and on the server) with the
query parameter bundle=0 for no bundling and bundle=1 for bundling. For
bundle=1 to work locally, need to start the server with "./gulp serve --bundle",
which is generally not recommended because compiles are >10x slower with
bundling.

## Recommendations
If you use VS Code you can get autoformatting of TS code on save with:

1. Install the clang-format extension: https://marketplace.visualstudio.com/items?itemName=xaver.clang-format
2. Added the following to your VSCode settings (change linux_x64 to darwin_x64 on mac):
  "clang-format.executable": "${workspaceRoot}/node_modules/clang-format/bin/linux_x64/clang-format",
  "[typescript]": {
    "editor.formatOnSave": true,
    "editor.formatOnType": true
  }

## Navigating the code
index.html is the file that gets served, but it basically just loads main.js,
which in turn loads everything else as ES Modules. Look at the onLoad() method
in main.js to see how the page boots up or the router.add calls to see how the
different routes get initialized.
