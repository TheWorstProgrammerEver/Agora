# Lib

General-purpose code that should feel like a small external library lives here.

Keep this folder free of product domain knowledge. Product contracts shared across client and server belong in `common`.

Apps using `lib/ui` should load `lib/ui/styles/foundation.scss` before rendering those components. App-specific globals, root sizing, scroll policy, and product token overrides should live in the app.
