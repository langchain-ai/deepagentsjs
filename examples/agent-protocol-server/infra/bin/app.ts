import * as cdk from "aws-cdk-lib";
import { AgentProtocolServerStack } from "../lib/stack.js";

const app = new cdk.App();

new AgentProtocolServerStack(app, "AgentProtocolServerStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
