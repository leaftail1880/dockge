import { defineComponent } from "vue";
import { currentLocale } from "../i18n";
import { setPageLocale } from "../util-frontend";

// @ts-ignore
const langModules = import.meta.glob("../lang/*.json");

export default defineComponent({
  data() {
    return {
      language: currentLocale(),
    };
  },

  watch: {
    async language(lang) {
      await this.changeLang(lang);
    },
  },

  async created() {
    if (this.language !== "en") {
      await this.changeLang(this.language);
    }
  },

  methods: {
    /**
     * Change the application language
     * @param lang Language code to switch to
     */
    async changeLang(lang: string): Promise<void> {
      const message = (
        (await langModules["../lang/" + lang + ".json"]()) as Record<
          string,
          unknown
        >
      ).default;

      // @ts-expect-error Vue is stupid
      this.$i18n.setLocaleMessage(lang, message);
      this.$i18n.locale = lang;
      localStorage.locale = lang;
      setPageLocale();
    },
  },
});
