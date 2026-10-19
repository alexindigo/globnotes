/** @type {import('tailwindcss').Config} */

export default {
  content: ["client/**/*.{html,js,vue}", "!client/dist/**"],
  darkMode: "selector",
  theme: {
    fontFamily: {
      sans: ["Poppins", "sans-serif"],
    },
    screens: {
      sm: "640px",
      md: "768px",
      lg: "1024px",
    },
    extend: {
      colors: {
        // Dynamic
        "theme-brand": "rgb(var(--theme-brand) / <alpha-value>)",
        "theme-warning": "rgb(var(--theme-warning) / <alpha-value>)",
        "theme-success": "rgb(var(--theme-success) / <alpha-value>)",
        "theme-danger": "rgb(var(--theme-danger) / <alpha-value>)",
        "theme-background": "rgb(var(--theme-background) / <alpha-value>)",
        "theme-background-elevated":
          "rgb(var(--theme-background-elevated) / <alpha-value>)",
        "theme-text": "rgb(var(--theme-text) / <alpha-value>)",
        "theme-text-muted": "rgb(var(--theme-text-muted) / <alpha-value>)",
        "theme-text-very-muted":
          "rgb(var(--theme-text-very-muted) / <alpha-value>)",
        "theme-shadow": "rgb(var(--theme-shadow) / <alpha-value>)",
        "theme-border": "rgb(var(--theme-border) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
