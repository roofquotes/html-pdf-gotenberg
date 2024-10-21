import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as docker from "@pulumi/docker";
import { execSync } from "child_process";

// Step 1: Create an ECR repository (if it doesn't exist)
const ecrRepo = new aws.ecr.Repository(
  "gotenberg-repo",
  {
    name: "gotenberg-repo",
    forceDelete: true,
  },
  {}
);

// Step 2: Get ECR credentials and login to Docker
const ecrCreds = pulumi
  .all([ecrRepo.repositoryUrl, ecrRepo.registryId])
  .apply(([repoUrl, registryId]) => {
    const loginCommand = `aws ecr get-login-password --region ${aws.config.region} | docker login --username AWS --password-stdin ${repoUrl}`;
    execSync(loginCommand, { stdio: "inherit" }); // Log in to ECR
    return repoUrl;
  });

// Step 3: Build the Docker image using the custom Dockerfile.roofquotes
const dockerImageName = "gotenberg-roofquotes";
execSync(
  `docker build -t ${dockerImageName} -f ../build/Dockerfile.roofquotes ..`,
  {
    stdio: "inherit",
  }
);

// Step 4: Tag the Docker image with the ECR repository URL
const ecrTag = ecrCreds.apply((repoUrl) => `${repoUrl}:1.0.6`);
ecrTag.apply((tag) => {
  execSync(`docker tag ${dockerImageName} ${tag}`, { stdio: "inherit" });
});

// Step 5: Push the tagged image to ECR
ecrTag.apply((tag) => {
  execSync(`docker push ${tag}`, { stdio: "inherit" });
});

// Step 6: Export the ECR image URL
export const ecrImageUrl = ecrTag;

// Step 7: Create an IAM role for the Lambda function
const lambdaRole = new aws.iam.Role("lambdaRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "lambda.amazonaws.com",
  }),
});

// Attach the CloudWatch Logs permission to the Lambda role
const lambdaPolicy = new aws.iam.RolePolicyAttachment(
  "lambdaPolicyAttachment",
  {
    role: lambdaRole.name,
    policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole, // This includes CloudWatch Logs permissions
  }
);

// Step 8: Create the Lambda function from the Docker image in ECR
const lambda = new aws.lambda.Function("gotenbergLambda", {
  packageType: "Image",
  memorySize: 8192,
  imageUri: ecrImageUrl,
  environment: {
    variables: {
      PORT: "8080", // Gotenberg will now listen on port 8080
    },
  },
  role: lambdaRole.arn,
  timeout: 900, // Adjust the timeout as needed
});

export const lambdaId = lambda.id;

// Step 9: Create an HTTP API (API Gateway v2) for Lambda
const httpApi = new aws.apigatewayv2.Api("gotenbergHttpApi", {
  protocolType: "HTTP",
  description: "HTTP API for Gotenberg Lambda function",
  target: lambda.arn.apply(
    (arn) =>
      `arn:aws:apigateway:${aws.config.region}:lambda:path/2015-03-31/functions/${arn}/invocations`
  ),
});

// Step 10: Grant permission for API Gateway to invoke Lambda
const lambdaPermission = new aws.lambda.Permission("apiGatewayPermission", {
  action: "lambda:InvokeFunction",
  function: lambda,
  principal: "apigateway.amazonaws.com",
  sourceArn: pulumi.interpolate`${httpApi.executionArn}/*/*`,
});

// Step 11: Deploy the API
const httpStage = new aws.apigatewayv2.Stage("gotenbergStage", {
  apiId: httpApi.id,
  name: pulumi.getStack(), // Define the stage (e.g., dev, prod)
  autoDeploy: true,
});

// Step 12: Export the HTTP API URL
export const httpApiUrl = pulumi.interpolate`${httpStage.invokeUrl}`;
