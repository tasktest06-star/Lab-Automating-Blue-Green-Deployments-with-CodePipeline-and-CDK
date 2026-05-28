import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// Configuration constants
const CONFIG = {
  PIPELINE_NAME: 'globomantics-pipeline',
  SOURCE_ARCHIVE: 'lambda-api-sam.zip',
  NODEJS_VERSION: 22,
  BUILD_IMAGE: codebuild.LinuxBuildImage.STANDARD_7_0,
  SAM_TEMPLATE: 'template.yaml',
  PACKAGED_TEMPLATE: 'packaged.yaml',
  STACK_NAMES: {
    DEV: 'lambda-api-sam-dev',
    TEST: 'lambda-api-sam-test',
    PROD: 'lambda-api-sam-prod',
  },
  DEPLOYMENT_PREFERENCES: {
    DEV: 'AllAtOnce',
    TEST: 'AllAtOnce',
    PROD: 'Linear10PercentEvery1Minute',
  },
};

export class ApiPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for source code
    const sourceBucket = this.createSourceBucket();

    // IAM roles
    const codeBuildRole = this.createCodeBuildRole();
    const codePipelineRole = this.createCodePipelineRole();

    // CodeBuild projects
    const samBuildProject = this.createBuildProject(codeBuildRole, sourceBucket);
    const devDeployProject = this.createDeployProject('DevDeployProject', codeBuildRole, sourceBucket, CONFIG.STACK_NAMES.DEV);
    // const testDeployProject = this.createDeployProject('TestDeployProject', codeBuildRole, sourceBucket, CONFIG.STACK_NAMES.TEST);
    // const prodDeployProject = this.createDeployProject('ProdDeployProject', codeBuildRole, sourceBucket, CONFIG.STACK_NAMES.PROD);
    const prodDeployProject = this.createDeployProject('ProdDeployProject', codeBuildRole, sourceBucket, CONFIG.STACK_NAMES.PROD, CONFIG.DEPLOYMENT_PREFERENCES.PROD);
    // CodePipeline
    //this.createPipeline(codePipelineRole, sourceBucket, samBuildProject, devDeployProject);
    this.createPipeline(codePipelineRole, sourceBucket, samBuildProject, devDeployProject, prodDeployProject);
    
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: sourceBucket.bucketName,
    });
  }

  private createSourceBucket(): s3.Bucket {
    return new s3.Bucket(this, 'SourceBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      versioned: true,
    });
  }

  private createCodeBuildRole(): iam.Role {
    return new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        CodeBuildPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                's3:GetObject',
                's3:PutObject',
                'cloudformation:*',
                'lambda:*',
                'apigateway:*',
                'iam:*',
                'codedeploy:*',
                'cloudwatch:*',
                'events:*'
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
  }

  private createCodePipelineRole(): iam.Role {
    return new iam.Role(this, 'CodePipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
      inlinePolicies: {
        CodePipelinePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:PutObject',
                'codebuild:BatchGetBuilds',
                'codebuild:StartBuild',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
  }

  private createBuildProject(role: iam.Role, sourceBucket: s3.Bucket): codebuild.Project {
    return new codebuild.Project(this, 'SamBuildProject', {
      role: role,
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: CONFIG.SOURCE_ARCHIVE,
      }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: CONFIG.NODEJS_VERSION,
            },
            commands: ['pip install aws-sam-cli'],
          },
          build: {
            commands: [
              'sam build',
              `sam package --template-file ${CONFIG.SAM_TEMPLATE} --s3-bucket ${sourceBucket.bucketName} --output-template-file ${CONFIG.PACKAGED_TEMPLATE}`,
            ],
          },
        },
        artifacts: {
          files: ['**/*'],
        },
      }),
      environment: {
        buildImage: CONFIG.BUILD_IMAGE,
        privileged: true,
      },
    });
  }

  private createDeployProject(
    id: string,
    role: iam.Role,
    sourceBucket: s3.Bucket,
    stackName: string,
    deploymentPreference?: string
  ): codebuild.Project {
    const deployCommand = deploymentPreference
      ? `sam deploy --template-file ${CONFIG.PACKAGED_TEMPLATE} --stack-name ${stackName} --s3-bucket ${sourceBucket.bucketName} --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides DeploymentPreferenceType=${deploymentPreference}`
      : `sam deploy --template-file ${CONFIG.PACKAGED_TEMPLATE} --stack-name ${stackName} --s3-bucket ${sourceBucket.bucketName} --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset`;

    return new codebuild.Project(this, id, {
      role: role,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: CONFIG.NODEJS_VERSION,
            },
            commands: ['pip install aws-sam-cli'],
          },
          build: {
            commands: [deployCommand],
          },
        },
      }),
      environment: {
        buildImage: CONFIG.BUILD_IMAGE,
        privileged: true,
      },
    });
  }

  private createPipeline(
    role: iam.Role,
    sourceBucket: s3.Bucket,
    buildProject: codebuild.Project,
    devDeployProject: codebuild.Project,
    prodDeployProject: codebuild.Project
  ): codepipeline.Pipeline {
    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    
    const stages = [
      this.createSourceStage(sourceBucket, sourceOutput),
      this.createBuildStage(buildProject, sourceOutput, buildOutput),
      this.createDeployStage('Dev', 'DeployToDev', devDeployProject, buildOutput),
      this.createApprovalStage('ApproveProduction', 'ApproveProductionDeployment'),
      this.createDeployStage('Production', 'DeployToProduction', prodDeployProject, buildOutput)
    ];

    return new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: CONFIG.PIPELINE_NAME,
      role: role,
      stages: stages,
    });
  }

  private createSourceStage(sourceBucket: s3.Bucket, output: codepipeline.Artifact): codepipeline.StageProps {
    return {
      stageName: 'Source',
      actions: [
        new codepipeline_actions.S3SourceAction({
          actionName: 'S3Source',
          bucket: sourceBucket,
          bucketKey: CONFIG.SOURCE_ARCHIVE,
          output: output,
          trigger: codepipeline_actions.S3Trigger.EVENTS,
        }),
      ],
    };
  }

  private createBuildStage(
    project: codebuild.Project,
    input: codepipeline.Artifact,
    output: codepipeline.Artifact
  ): codepipeline.StageProps {
    return {
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'SamBuild',
          project: project,
          input: input,
          outputs: [output],
        }),
      ],
    };
  }

  private createApprovalStage(stageName: string, actionName: string): codepipeline.StageProps {
    return {
      stageName: stageName,
      actions: [
        new codepipeline_actions.ManualApprovalAction({
          actionName: actionName,
        }),
      ],
    };
  }

  private createDeployStage(
    stageName: string,
    actionName: string,
    project: codebuild.Project,
    input: codepipeline.Artifact
  ): codepipeline.StageProps {
    return {
      stageName: stageName,
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: actionName,
          project: project,
          input: input,
        }),
      ],
    };
  }
}
