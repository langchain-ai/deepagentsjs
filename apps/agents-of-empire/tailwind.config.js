/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        empire: {
          gold: '#f4d03f',
          dark: '#1a1a2e',
          red: '#e74c3c',
          green: '#27ae60',
          blue: '#3498db',
        },
      },
      fontFamily: {
        'medieval': ['MedievalSharp', 'serif'],
      },
    },
  },
  plugins: [],
};
