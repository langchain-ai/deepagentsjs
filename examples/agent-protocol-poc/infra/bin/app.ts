import * as cdk from "aws-cdk-lib";
import { ResearcherStack } from "../lib/researcher-stack.js";

const app = new cdk.App();

new ResearcherStack(app, "ResearcherStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
