#!/bin/bash
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

echo
echo "--------------------[[[[ Testing wskdebug installation ]]]]--------------------"
echo

npm pack
mv openwhisk-wskdebug-*.tgz test/install/openwhisk-wskdebug.tgz

cd test/install

docker build --no-cache .
exitcode=$?

# remove any leftover image again, we only run it for testing
docker rmi -f $(docker images -q -f label=type=test)

echo
if [ $exitcode -ne 0 ]; then
    echo "ERROR: Installation test failed!" >&2
    exit $exitcode
else
    echo "Installation test was successful."
fi
