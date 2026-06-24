import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ChatApp } from "@/components/ChatApp";
import "@/styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>
);
