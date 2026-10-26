import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "motion/react";
import "./index.css";
import { installTheme, savedBrand, savedMode, setBrand, setMode } from "@spot/ui";
import App from "./App";


installTheme();
setBrand(savedBrand(), { persist: false });
setMode(savedMode());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MotionConfig>
  </StrictMode>,
);
