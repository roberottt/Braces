import { render } from "solid-js/web";
import App from "./App";
import { isMac } from "./platform";
import "./styles/global.css";

// Platform flag for CSS: on macOS the window uses native decorations with the
// traffic lights overlaid (titleBarStyle Overlay), so the custom window
// buttons are hidden and the status bar leaves room on the left.
if (isMac) {
  document.documentElement.dataset.platform = "macos";
}

const root = document.getElementById("root")!;
const dispose = render(() => <App />, root);

// On HMR re-execution of this module, tear down the previous app tree first.
// Without this, each hot reload stacks another live <App /> (duplicated global
// keyboard listeners → Ctrl+Alt+T spawning N tabs).
if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose());
}
