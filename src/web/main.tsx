import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./App.tsx";
import { ApiClient } from "./api.ts";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App client={new ApiClient()} /></StrictMode>,
);
