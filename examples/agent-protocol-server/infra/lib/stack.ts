import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/**
 * AgentProtocolServerStack
 *
 * Deploys the minimal independent Agent Protocol server to ECS Fargate.
 * No Postgres. No Redis. No LangSmith license key.
 *
 * Deploy steps:
 *   1. cdk deploy
 *   2. docker build --platform linux/amd64 -f ../Dockerfile -t agent-protocol-server ../../../
 *   3. docker tag agent-protocol-server <EcrRepositoryUri>:latest
 *   4. docker push <EcrRepositoryUri>:latest
 *   5. aws ecs update-service --cluster ... --service ... --force-new-deployment
 *   6. Set RESEARCHER_URL in .env to the ServerUrl output
 */
export class AgentProtocolServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
    });

    // ── ECR ──────────────────────────────────────────────────────────────────
    const repository = new ecr.Repository(this, "Repo", {
      repositoryName: "agent-protocol-server",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // ── Security groups ──────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "ALB: allow inbound 2024 from anywhere",
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(2024));

    const taskSg = new ec2.SecurityGroup(this, "TaskSg", {
      vpc,
      description: "ECS task: allow inbound from ALB",
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(2024));

    // ── ECS ──────────────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    repository.grantPull(taskDef.obtainExecutionRole());

    taskDef.addContainer("Server", {
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      portMappings: [{ containerPort: 2024 }],
      environment: {
        PORT: "2024",
      },
      secrets: {
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(
          secretsmanager.Secret.fromSecretNameV2(
            this,
            "AnthropicKey",
            "agent-protocol-server/ANTHROPIC_API_KEY",
          ),
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "agent-protocol-server" }),
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [taskSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ── ALB ──────────────────────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const listener = alb.addListener("Listener", {
      port: 2024,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });

    listener.addTargets("Target", {
      port: 2024,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/ok",
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: "200",
      },
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ServerUrl", {
      value: `http://${alb.loadBalancerDnsName}:2024`,
      description: "Set this as RESEARCHER_URL in your .env",
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: repository.repositoryUri,
      description: "Push your server image here",
    });
  }
}
