import { createRoot } from "react-dom/client";
import { NotificationPopup } from "./features/notifications/NotificationPopup";
import "./design-system/fonts.css";
import "./design-system/tokens.css";

createRoot(document.getElementById("root")!).render(<NotificationPopup />);
