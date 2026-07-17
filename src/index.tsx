import { render } from "solid-js/web";
import App from "./App";
import { isMac, isLinux } from "./platform";
import "./styles/global.css";

// Platform flag for CSS: on macOS the window uses native decorations with the
// traffic lights overlaid (titleBarStyle Overlay), so the custom window
// buttons are hidden and the status bar leaves room on the left.
if (isMac) {
  document.documentElement.dataset.platform = "macos";
} else if (isLinux) {
  // On Linux the window is opaque (transparency is unreliable on WebKitGTK),
  // so the rounded corners would expose the WebView's default background.
  // Square them off and give the shell an opaque backdrop.
  document.documentElement.dataset.platform = "linux";
}

const root = document.getElementById("root")!;
const dispose = render(() => <App />, root);

// On HMR re-execution of this module, tear down the previous app tree first.
// Without this, each hot reload stacks another live <App /> (duplicated global
// keyboard listeners → Ctrl+Alt+T spawning N tabs).
if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose());
}
