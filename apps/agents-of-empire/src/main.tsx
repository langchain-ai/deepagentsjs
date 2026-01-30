import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// ============================================================================
// Error Boundary
// ============================================================================()

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Agents of Empire crashed:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 bg-gray-900 flex items-center justify-center text-white">
          <div className="text-center">
            <div className="text-6xl mb-4">💥</div>
            <h1 className="text-2xl font-bold text-empire-red mb-4">
              A TypeScript Dragon Has Struck!
            </h1>
            <p className="text-gray-400 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-empire-gold text-gray-900 rounded font-bold"
            >
              Reload the Battle
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// ============================================================================
// Mount the App
// ============================================================================()

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
