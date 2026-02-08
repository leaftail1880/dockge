module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:vue/vue3-recommended",
  ],
  parser: "vue-eslint-parser",
  parserOptions: {
    parser: "@typescript-eslint/parser",
  },
  plugins: ["@typescript-eslint", "jsdoc"],
  rules: {
    yoda: "error",
    camelcase: [
      "warn",
      {
        properties: "never",
        ignoreImports: true,
      },
    ],
    "no-unused-vars": [
      "warn",
      {
        args: "none",
      },
    ],
    "vue/max-attributes-per-line": "off",
    "vue/singleline-html-element-content-newline": "off",
    "vue/html-self-closing": "off",
    "vue/require-component-is": "off", // not allow is="style" https://github.com/vuejs/eslint-plugin-vue/issues/462#issuecomment-430234675
    "vue/attribute-hyphenation": "off", // This change noNL to "no-n-l" unexpectedly
    "vue/multi-word-component-names": "off",

    "no-var": "error",
    "no-constant-condition": [
      "error",
      {
        checkLoops: false,
      },
    ],
    "no-extra-boolean-cast": "off",
    "no-unneeded-ternary": "error",
    "no-control-regex": "off",
    "one-var": ["error", "never"],
    "max-statements-per-line": ["error", { max: 1 }],
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        args: "none",
      },
    ],
    "prefer-const": "off",
    "vue/html-indent": "off",
    "vue/html-closing-bracket-newline": "off",
  },
};
