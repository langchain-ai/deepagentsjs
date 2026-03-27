import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/**
 * ResearcherStack
 *
 * Provisions the infrastructure needed to self-host a LangGraph Agent Protocol
 * server (the researcher subagent) on ECS Fargate with no LangSmith dependency.
 *
 * Architecture:
 *   Supervisor (local) → ALB → ECS Fargate (langgraph-api) → RDS Postgres + ElastiCache Redis
 *
 * Deploy steps:
 *   1. cdk deploy                — provisions ECR repo and all infra; note the EcrRepositoryUri output
 *   2. langgraph build -t researcher -c examples/agent-protocol-poc/langgraph.json
 *   3. docker tag researcher <EcrRepositoryUri>:latest && docker push <EcrRepositoryUri>:latest
 *   4. aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment
 *   5. Set RESEARCHER_URL in .env to the ResearcherUrl output
 */
export class ResearcherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
    });

    // ── ECR repository ───────────────────────────────────────────────────────
    const repository = new ecr.Repository(this, "ResearcherRepo", {
      repositoryName: "researcher",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // ── Security groups ──────────────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "ALB: allow inbound 8123 from anywhere",
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8123));

    const taskSg = new ec2.SecurityGroup(this, "TaskSg", {
      vpc,
      description: "ECS task: allow inbound from ALB",
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(8123));

    const rdsSg = new ec2.SecurityGroup(this, "RdsSg", {
      vpc,
      description: "RDS: allow inbound from ECS task",
    });
    rdsSg.addIngressRule(taskSg, ec2.Port.tcp(5432));

    const redisSg = new ec2.SecurityGroup(this, "RedisSg", {
      vpc,
      description: "Redis: allow inbound from ECS task",
    });
    redisSg.addIngressRule(taskSg, ec2.Port.tcp(6379));

    // ── RDS PostgreSQL ───────────────────────────────────────────────────────
    const dbSecret = new secretsmanager.Secret(this, "DbSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "langgraph" }),
        generateStringKey: "password",
        excludeCharacters: "/@\"' ",
      },
    });

    const dbSubnetGroup = new rds.SubnetGroup(this, "DbSubnetGroup", {
      vpc,
      description: "RDS subnet group",
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      subnetGroup: dbSubnetGroup,
      securityGroups: [rdsSg],
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "langgraph",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // ── ElastiCache Redis ────────────────────────────────────────────────────
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "RedisSubnetGroup",
      {
        description: "Redis subnet group",
        subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
      },
    );

    const redis = new elasticache.CfnCacheCluster(this, "Redis", {
      cacheNodeType: "cache.t4g.micro",
      engine: "redis",
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });

    // ── ECS cluster + task ───────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    repository.grantPull(taskDef.obtainExecutionRole());

    const redisUri = `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;

    // DATABASE_URI must be stored as a pre-built secret because the RDS-generated
    // password contains special characters that break URL parsing if inlined at synth time.
    // After deploying, run the post-deploy script to populate this secret with the
    // URL-encoded URI, then force a new ECS deployment.
    const postgresUriSecret = new secretsmanager.Secret(this, "PostgresUriSecret", {
      secretName: "agent-protocol-poc/DATABASE_URI",
      description: "postgresql+psycopg://... URI for langgraph-api (populate after RDS is created)",
    });

    taskDef.addContainer("Researcher", {
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      portMappings: [{ containerPort: 8123 }],
      environment: {
        REDIS_URI: redisUri,
        PORT: "8123",
      },
      secrets: {
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(
          secretsmanager.Secret.fromSecretNameV2(
            this,
            "AnthropicKey",
            "agent-protocol-poc/ANTHROPIC_API_KEY",
          ),
        ),
        DATABASE_URI: ecs.Secret.fromSecretsManager(postgresUriSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "researcher" }),
    });

    // ── Fargate service ──────────────────────────────────────────────────────
    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [taskSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ── Application Load Balancer ────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const listener = alb.addListener("Listener", {
      port: 8123,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });

    listener.addTargets("ResearcherTarget", {
      port: 8123,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/ok",
        interval: cdk.Duration.seconds(30),
        healthyHttpCodes: "200",
      },
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ResearcherUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "Set this as RESEARCHER_URL in your .env",
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: repository.repositoryUri,
      description: "Push your researcher image here",
    });
  }
}
