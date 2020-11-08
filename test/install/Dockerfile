#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

# docker build for testing wskdebug installation
FROM circleci/node:lts
LABEL type=test

WORKDIR /home/circleci
COPY openwhisk-wskdebug.tgz .
COPY wskprops .wskprops

# https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
# ~/.local/bin is already on the PATH
RUN mkdir ~/.local && npm config set prefix '~/.local'

RUN npm install -g openwhisk-wskdebug.tgz

RUN wskdebug -h && wskdebug --version

# specifying --ngrok should give a specific error message
RUN wskdebug --ngrok myaction 2>&1 | grep -A 10 "ngrok dependency required for --ngrok is not installed"

# fix by installing ngrok
RUN npm install -g ngrok --unsafe-perm=true

# then we should get another error (as we can't run it without docker)
RUN wskdebug --ngrok myaction 2>&1 | grep -A 10 -E "(Error: Unknown Error From API: socket hang up|Docker not running on local system. A local docker environment is required for the debugger.)"
