/**
 * 软 DTU WebView 入口
 *
 * Preact 挂载到 #app，注入全局样式。
 */

import { render } from "preact";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("app");
if (!root) {
  throw new Error("#app mount point not found");
}

render(<App />, root);
