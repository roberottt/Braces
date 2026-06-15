import { render } from "solid-js/web";
import App from "./App";
import "./styles/global.css";

const root = document.getElementById("root")!;
const dispose = render(() => <App />, root);

// On HMR re-execution of this module, tear down the previous app tree first.
// Without this, each hot reload stacks another live <App /> (duplicated global
// keyboard listeners → Ctrl+Alt+T spawning N tabs).
if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose());
}
