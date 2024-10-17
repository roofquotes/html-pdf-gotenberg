import * as pulumi from "@pulumi/pulumi";
import * as awsx from "@pulumi/awsx";
import * as aws from "@pulumi/aws";
import * as docker from "@pulumi/docker";
import { ContainerDefinition } from "@pulumi/aws/ecs";
//import { execSync } from "child_process";

// Step 1: Create an ECR repository (if it doesn't exist)
const ecrRepo = new aws.ecr.Repository("gotenberg-repo", {
  name: "gotenberg-repo",
  forceDelete: true,
});

// // Step 2: Get ECR credentials and login to Docker
// const ecrCreds = pulumi
//   .all([ecrRepo.repositoryUrl, ecrRepo.registryId])
//   .apply(([repoUrl, registryId]) => {
//     const loginCommand = `aws ecr get-login-password --region ${aws.config.region} | docker login --username AWS --password-stdin ${repoUrl}`;
//     execSync(loginCommand, { stdio: "inherit" }); // Log in to ECR
//     return repoUrl;
//   });

// // Step 3: Build the Docker image using the custom Dockerfile.roofquotes
// const dockerImageName = "gotenberg-roofquotes";
// execSync(
//   `docker build -t ${dockerImageName} -f ../build/Dockerfile.roofquotes ..`,
//   { stdio: "inherit" }
// );

// // Step 4: Tag the Docker image with the ECR repository URL
// const ecrTag = ecrCreds.apply((repoUrl) => `${repoUrl}:1.0.6`);
// ecrTag.apply((tag) => {
//   execSync(`docker tag ${dockerImageName} ${tag}`, { stdio: "inherit" });
// });

// // Step 5: Push the tagged image to ECR
// ecrTag.apply((tag) => {
//   execSync(`docker push ${tag}`, { stdio: "inherit" });
// });

const image = new awsx.ecr.Image("image", {
  repositoryUrl: ecrRepo.repositoryUrl,
  context: "..",
  dockerfile: "../build/Dockerfile.roofquotes",
  platform: "linux/amd64",
  imageTag: "latest",
});
// Export the ECR image URL
export const imageUrl = image.imageUri; //pulumi.interpolate`${ecrRepo.repositoryUrl}:latest`

// Step 1: Create a VPC using awsx (simplifies the VPC creation)
const vpc = new awsx.ec2.Vpc("gotenberg-vpc", {
  numberOfAvailabilityZones: 2,
});

// Step 2: Create an ECS Cluster using the AWS package
const cluster = new aws.ecs.Cluster("gotenberg-cluster", {
  name: "gotenberg-cluster",
  // capacityProviders: ["FARGATE"],
});

// Step 3: Create a Security Group for the Application Load Balancer
const albSecurityGroup = new aws.ec2.SecurityGroup("alb-sg", {
  vpcId: vpc.vpcId, // Correctly access the VPC ID
  ingress: [
    {
      protocol: "tcp",
      fromPort: 80,
      toPort: 80,
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      protocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      protocol: "-1", // All protocols allowed for outbound
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

// Step 4 Create the Application Load Balancer (ALB)
const alb = new aws.lb.LoadBalancer("alb", {
  securityGroups: [albSecurityGroup.id],
  subnets: vpc.publicSubnetIds,
  loadBalancerType: "application",
  internal: false, // To make it publicly accessible
});

// Step 5: Create a Target Group for the Fargate Service
const targetGroup = new aws.lb.TargetGroup("gotenberg-target-group", {
  port: 3000,
  protocol: "HTTP",
  targetType: "ip",
  vpcId: vpc.vpcId,
  healthCheck: {
    path: "/health",
    protocol: "HTTP",
    //port: "3000",
    interval: 30, // Increase interval to give the app more time
    timeout: 5,
    healthyThreshold: 2,
    unhealthyThreshold: 2,
  },
});

const certificate = aws.acm.Certificate.get(
  "roofquotes-certificate",
  "arn:aws:acm:us-east-1:350326641471:certificate/64e64e85-1a30-42ad-871e-b3d40169aad9"
);

// Step 6:  Create a Listener for HTTPS Traffic on Port 443
const httpsListener = new aws.lb.Listener("web-listener", {
  loadBalancerArn: alb.arn,
  port: 443,
  protocol: "HTTPS",
  sslPolicy: "ELBSecurityPolicy-2016-08",
  certificateArn: certificate.arn,
  defaultActions: [
    {
      type: "forward",
      targetGroupArn: targetGroup.arn,
    },
  ],
});

// Step 9: Create a Listener for HTTP Traffic on Port 80 to Redirect to HTTPS
const httpListener = new aws.lb.Listener("http-listener", {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: "HTTP",
  defaultActions: [
    {
      type: "redirect",
      redirect: {
        protocol: "HTTPS",
        port: "443",
        statusCode: "HTTP_301",
      },
    },
  ],
});

// Step 7: Define the IAM Role for ECS Task Execution
const taskExecutionRole = new aws.iam.Role("ecsTaskExecutionRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ecs-tasks.amazonaws.com",
  }),
});

// Attach necessary policies to the execution role for ECS to use CloudWatch logs
const taskPolicyAttachment = new aws.iam.RolePolicyAttachment(
  "taskExecutionRolePolicyAttachment",
  {
    role: taskExecutionRole.name,
    // policyArn: aws.iam.ManagedPolicies.AmazonECSTaskExecutionRolePolicy,
    policyArn:
      "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  }
);

// Additional custom policy for CloudWatch logging
const cloudWatchPolicy = new aws.iam.Policy("cloudWatchPolicy", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Resource: "*",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("cloudWatchPolicyAttachment", {
  role: taskExecutionRole.name,
  policyArn: cloudWatchPolicy.arn,
});

// Step 8: Add SSM Permissions to Task Execution Role
const ssmExecutionPolicy = new aws.iam.Policy("ssmExecutionPolicy", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        Resource: "*",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("ssmExecutionPolicyAttachment", {
  role: taskExecutionRole.name,
  policyArn: ssmExecutionPolicy.arn,
});

// Step 9: Create Task Role for ECS Task
const taskRole = new aws.iam.Role("ecsTaskRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ecs-tasks.amazonaws.com",
  }),
});

// Attach custom policy to Task Role for SSM messages
const ssmPolicy = new aws.iam.Policy("ssmPolicy", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "VisualEditor0",
        Effect: "Allow",
        Action: "ssmmessages:*",
        Resource: "*",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("ssmPolicyAttachment", {
  role: taskRole.name,
  policyArn: ssmPolicy.arn,
});

// Step 10: Define the Log Group for Container Logs
const logGroup = new aws.cloudwatch.LogGroup("gotenberg-log-group", {
  name: "/ecs/gotenberg",
  retentionInDays: 14, // Set log retention as desired
});

export const logGroupArn = logGroup.arn;

// Step 11: Define the Fargate Task Definition with Logging Configuration
const taskDefinition = new aws.ecs.TaskDefinition("gotenberg-task", {
  family: "gotenberg-task",
  containerDefinitions: pulumi.output(image.imageUri).apply((url) =>
    JSON.stringify([
      {
        name: "gotenberg-container",
        image: url,
        memory: 4096,
        cpu: 2048,
        portMappings: [
          {
            containerPort: 3000,
            //hostPort: 3000,
            protocol: "tcp",
          },
        ],
        logGroupArn: logGroupArn,
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": "/ecs/gotenberg",
            "awslogs-region": aws.config.region,
            "awslogs-stream-prefix": "gotenberg",
          },
        },
        environment: [],
        // command: [], // use this to give startup args to gotenberg
      } as ContainerDefinition,
    ])
  ),
  requiresCompatibilities: ["FARGATE"],
  networkMode: "awsvpc",
  cpu: "2048",
  memory: "4096",
  executionRoleArn: taskExecutionRole.arn,
  taskRoleArn: taskRole.arn,
});

// Step 12: Define the Security Group for the Fargate Task
const taskSecurityGroup = new aws.ec2.SecurityGroup(
  "ecs-task-sg",
  {
    vpcId: vpc.vpcId,
    ingress: [
      {
        protocol: "tcp",
        fromPort: 3000,
        toPort: 3000,
        securityGroups: [albSecurityGroup.id],
        //cidrBlocks: ["0.0.0.0/0"], // Allow inbound traffic from anywhere on port 3000
      },
    ],
    egress: [
      {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"], // Allow all outbound traffic
      },
    ],
  },
  { dependsOn: [albSecurityGroup] }
);

// Step 13: Define the Fargate Service using aws
const fargateService = new aws.ecs.Service(
  "gotenberg-service",
  {
    healthCheckGracePeriodSeconds: 60,
    cluster: cluster.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    taskDefinition: taskDefinition.arn,
    forceNewDeployment: true,
    networkConfiguration: {
      assignPublicIp: true,
      subnets: vpc.publicSubnetIds,
      securityGroups: [albSecurityGroup.id, taskSecurityGroup.id],
    },
    loadBalancers: [
      {
        targetGroupArn: targetGroup.arn,
        containerName: "gotenberg-container",
        containerPort: 3000,
      },
    ],
  },
  { dependsOn: [taskDefinition, targetGroup, httpsListener] }
);

// Step 14: Export the Load Balancer URL for the Fargate Service
export const url = alb.dnsName;

image.imageUri.apply((uri) => {
  console.log(`Image URI: ${uri}`);
  console.log(`Image URI Length: ${uri.length}`);
});
