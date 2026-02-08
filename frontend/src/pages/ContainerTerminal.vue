<template>
  <transition name="slide-fade" appear>
    <div>
      <h1 class="mb-3">
        {{ $t("terminal") }} - {{ serviceName }} ({{ stackName }})
      </h1>

      <div class="mb-3">
        <router-link :to="sh" class="btn btn-normal me-2">
          {{ $t("Switch to sh") }}
        </router-link>
      </div>

      <Terminal
        class="terminal"
        :rows="20"
        mode="interactive"
        :name="terminalName"
        :stack-name="stackName"
        :service-name="serviceName"
        :shell="shell"
        :endpoint="endpoint"
      ></Terminal>
    </div>
  </transition>
</template>

<script>
import { getContainerExecTerminalName } from "../../../common/util-common";
import Terminal from "../components/Terminal.vue";

export default {
  components: {
    Terminal,
  },
  data() {
    return {
      isAttach: false,
      loading: true,
      terminalReady: false,
      error: "",
      attachTerminalName: "",
    };
  },
  computed: {
    stackName() {
      return this.$route.params.stackName;
    },
    endpoint() {
      return this.$route.params.endpoint || "";
    },
    shell() {
      return this.$route.params.type;
    },
    serviceName() {
      return this.$route.params.serviceName;
    },
    mode() {
      return this.$route.query.mode === "attach" ? "attach" : "exec";
    },
    sh() {
      let endpoint = this.$route.params.endpoint;

      let data = {
        name: "containerTerminal",
        params: {
          stackName: this.stackName,
          serviceName: this.serviceName,
          type: "sh",
        },
      };

      if (endpoint) {
        data.name = "containerTerminalEndpoint";
        data.params.endpoint = endpoint;
      }

      return data;
    },
    terminalName() {
      if (this.isAttach || this.mode === "attach") {
        // Use attach terminal naming convention
        let endpointStr = this.endpoint ? this.endpoint : "";
        // Must match backend naming
        return `attach-${this.serviceName}-${endpointStr}`;
      } else {
        return getContainerExecTerminalName(
          this.endpoint,
          this.stackName,
          this.serviceName,
          0,
        );
      }
    },
  },
  watch: {
    $route() {
      // Watch for query mode changes or navigation
      this.openSession();
    },
  },
  mounted() {
    this.openSession();
  },
  methods: {
    openSession() {
      this.loading = true;
      this.error = "";
      this.terminalReady = false;
      this.isAttach = this.mode === "attach";
      const socket = this.$root.getSocket();

      if (this.isAttach) {
        // Ask backend to create/join attach terminal (gets logs + attaches)
        socket.emit("attachTerminal", this.serviceName, (resp) => {
          if (!resp || !resp.ok) {
            this.error = resp && resp.msg ? resp.msg : "Failed to attach.";
            this.loading = false;
            this.terminalReady = false;
            return;
          }
          this.terminalReady = true;
          this.loading = false;
        });
      } else {
        // Interactive shell (exec)
        socket.emit(
          "interactiveTerminal",
          this.stackName,
          this.serviceName,
          this.shell,
          (resp) => {
            if (!resp || !resp.ok) {
              this.error =
                resp && resp.msg ? resp.msg : "Could not start exec shell.";
              this.loading = false;
              this.terminalReady = false;
              return;
            }
            this.terminalReady = true;
            this.loading = false;
          },
        );
      }
    },
  },
};
</script>

<style scoped lang="scss">
.terminal {
  height: 410px;
}
</style>
