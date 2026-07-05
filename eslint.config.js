import js from "@eslint/js";
import globals from "globals";

export default [
	{
		ignores: ["node_modules/**"],
	},
	js.configs.recommended,
	{
		files: ["dist/**/*.js", "worker.test.js"],
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.serviceworker,
				...globals.es2024,
			},
		},
		rules: {
			"no-console": ["error", { allow: ["error", "warn"] }],
			"no-unused-vars": ["error", { args: "none" }],
		},
	},
];
