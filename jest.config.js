module.exports = {
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2020",
        },
      },
    ],
  },
  coverageProvider: "v8",
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageThreshold: {
    global: { statements: 90, branches: 85, functions: 90, lines: 90 },
    "./src/sources/": { statements: 85, branches: 80, functions: 85, lines: 85 },
    "./src/App.ts": { statements: 90, branches: 80, functions: 95, lines: 90 },
  },
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testEnvironment: "node",
};
